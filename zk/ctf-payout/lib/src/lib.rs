//! Proves a Gnosis ConditionalTokens (CTF) payout from Polygon state: the account and storage proofs are checked
//! against the state root of a block header, and the block hash is committed so a light client can anchor it.
use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_rlp::{Decodable, Header};
use alloy_sol_types::sol;
use alloy_trie::{proof::verify_proof, Nibbles};
use serde::{Deserialize, Serialize};

/// Polymarket's CTF on Polygon.
pub const CTF: Address = Address::new(hex_literal::hex!("4D97DCd97eC945f40cF65F87097ACe5EA0476045"));
/// Storage slots of `payoutNumerators` (mapping to uint[]) and `payoutDenominator` (mapping to uint), found on-chain.
const NUMERATORS_SLOT: u64 = 3;
const DENOMINATOR_SLOT: u64 = 4;

sol! {
    struct PayoutPublicValues {
        bytes32 blockHash;
        bytes32 conditionId;
        uint256 denominator;
        uint256 numerator0;
        uint256 numerator1;
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PayoutInput {
    pub header_rlp: Vec<u8>,
    pub condition_id: B256,
    /// RLP of the CTF account (nonce, balance, storageRoot, codeHash) and its proof under the state root.
    pub account_rlp: Vec<u8>,
    pub account_proof: Vec<Vec<u8>>,
    /// Claimed values and proofs for: denominator, numerators length, numerator 0, numerator 1.
    pub values: [U256; 4],
    pub storage_proofs: [Vec<Vec<u8>>; 4],
}

fn mapping_slot(key: B256, slot: u64) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(key.as_slice());
    buf[32..].copy_from_slice(&U256::from(slot).to_be_bytes::<32>());
    keccak256(buf)
}

/// The 4th item of a header's RLP list is its state root.
fn state_root(header_rlp: &[u8]) -> B256 {
    let mut buf = header_rlp;
    let list = Header::decode(&mut buf).expect("header rlp");
    assert!(list.list, "header is an RLP list");
    for _ in 0..3 {
        let item = Header::decode(&mut buf).expect("header field");
        buf = &buf[item.payload_length..];
    }
    B256::decode(&mut buf).expect("state root")
}

fn storage_root(account_rlp: &[u8]) -> B256 {
    let mut buf = account_rlp;
    let list = Header::decode(&mut buf).expect("account rlp");
    assert!(list.list, "account is an RLP list");
    let _nonce = u64::decode(&mut buf).expect("nonce");
    let _balance = U256::decode(&mut buf).expect("balance");
    B256::decode(&mut buf).expect("storage root")
}

/// Panics unless every proof verifies; returns what the guest commits.
pub fn verify(input: &PayoutInput) -> PayoutPublicValues {
    let root = state_root(&input.header_rlp);
    let account_key = Nibbles::unpack(keccak256(CTF));
    verify_proof(root, account_key, Some(input.account_rlp.clone()), input.account_proof.iter().map(|n| n.clone().into()).collect::<Vec<_>>().iter())
        .expect("CTF account proof");
    let sroot = storage_root(&input.account_rlp);

    let len_slot = mapping_slot(input.condition_id, NUMERATORS_SLOT);
    let first = U256::from_be_bytes(keccak256(len_slot).0);
    let slots = [mapping_slot(input.condition_id, DENOMINATOR_SLOT), len_slot, B256::from(first), B256::from(first + U256::from(1))];
    for (i, slot) in slots.iter().enumerate() {
        let value = input.values[i];
        // Zero values are absent from the trie; anything else is stored RLP-encoded.
        let expected = (!value.is_zero()).then(|| alloy_rlp::encode(value));
        verify_proof(sroot, Nibbles::unpack(keccak256(slot)), expected, input.storage_proofs[i].iter().map(|n| n.clone().into()).collect::<Vec<_>>().iter())
            .expect("CTF storage proof");
    }
    assert_eq!(input.values[1], U256::from(2), "binary condition");
    PayoutPublicValues {
        blockHash: keccak256(&input.header_rlp),
        conditionId: input.condition_id,
        denominator: input.values[0],
        numerator0: input.values[2],
        numerator1: input.values[3],
    }
}
