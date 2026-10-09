//! Proves a Gnosis ConditionalTokens (CTF) payout from Polygon state: the account and storage proofs are checked
//! against the state root of a block header, and the block hash is committed so a light client can anchor it.
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_rlp::{Decodable, Header};
use alloy_sol_types::{sol, SolEvent};
use alloy_trie::{proof::{verify_proof, ProofRetainer}, root::adjust_index_for_rlp, HashBuilder, Nibbles};
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

sol! {
    event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount, uint[] payoutNumerators);
}

/// Polygon's RootChain proxy on Ethereum; `headerBlocks` (root, start, end, createdAt, proposer) is mapping slot 5.
pub const ROOT_CHAIN: Address = Address::new(hex_literal::hex!("86E4Dc95c7FBdBf52e33D563BbDB00823894C287"));
const HEADER_BLOCKS_SLOT: u64 = 5;

fn receipt_key(index: usize) -> Nibbles {
    Nibbles::unpack(alloy_rlp::encode(index))
}

/// Rebuilds the receipt trie from EIP-2718 encoded receipts; returns its root and the proof for `index`.
pub fn receipt_trie(receipts: &[Vec<u8>], index: usize) -> (B256, Vec<Vec<u8>>) {
    let target = receipt_key(index);
    let mut hb = HashBuilder::default().with_proof_retainer(ProofRetainer::new(vec![target]));
    for i in 0..receipts.len() {
        let j = adjust_index_for_rlp(i, receipts.len());
        hb.add_leaf(receipt_key(j), &receipts[j]);
    }
    let root = hb.root();
    let proof = hb.take_proof_nodes().matching_nodes_sorted(&target).into_iter().map(|(_, n)| n.to_vec()).collect();
    (root, proof)
}

pub fn verify_receipt(receipts_root: B256, index: usize, receipt: &[u8], proof: &[Vec<u8>]) -> bool {
    let nodes: Vec<Bytes> = proof.iter().map(|n| n.clone().into()).collect();
    verify_proof(receipts_root, receipt_key(index), Some(receipt.to_vec()), nodes.iter()).is_ok()
}

/// Finds the CTF's ConditionResolution for `condition_id` in an EIP-2718 receipt; returns (numerators, denominator).
pub fn condition_payout(receipt: &[u8], condition_id: B256) -> Option<(Vec<U256>, U256)> {
    let mut buf = match receipt.first()? {
        0x01..=0x7f => &receipt[1..],
        _ => receipt,
    };
    let list = Header::decode(&mut buf).ok()?;
    if !list.list || buf.len() != list.payload_length {
        return None;
    }
    for _ in 0..3 {
        let item = Header::decode(&mut buf).ok()?;
        buf = buf.get(item.payload_length..)?;
    }
    let logs = Header::decode(&mut buf).ok()?;
    let mut logs_buf = buf.get(..logs.payload_length)?;
    while !logs_buf.is_empty() {
        let log = Header::decode(&mut logs_buf).ok()?;
        let mut fields = logs_buf.get(..log.payload_length)?;
        logs_buf = &logs_buf[log.payload_length..];
        let address = Address::decode(&mut fields).ok()?;
        let topics = Vec::<B256>::decode(&mut fields).ok()?;
        let data = Bytes::decode(&mut fields).ok()?;
        if address == CTF && topics.len() == 4 && topics[0] == ConditionResolution::SIGNATURE_HASH && topics[1] == condition_id {
            let (_slots, numerators) = ConditionResolution::abi_decode_data(&data).ok()?;
            let denominator = numerators.iter().fold(U256::ZERO, |a, n| a + n);
            return Some((numerators, denominator));
        }
    }
    None
}

/// The fields of a Bor block that its checkpoint commits to.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct BorHeader {
    pub number: u64,
    pub time: u64,
    pub tx_root: B256,
    pub receipt_root: B256,
}

/// keccak256(pad32(number) ‖ pad32(time) ‖ txRoot ‖ receiptRoot), as bor's computeRootHash builds it.
pub fn bor_leaf(h: &BorHeader) -> B256 {
    let mut buf = [0u8; 128];
    buf[24..32].copy_from_slice(&h.number.to_be_bytes());
    buf[56..64].copy_from_slice(&h.time.to_be_bytes());
    buf[64..96].copy_from_slice(h.tx_root.as_slice());
    buf[96..].copy_from_slice(h.receipt_root.as_slice());
    keccak256(buf)
}

fn hash_pair(a: B256, b: B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(a.as_slice());
    buf[32..].copy_from_slice(b.as_slice());
    keccak256(buf)
}

/// Checkpoint Merkle root over `leaves` (zero-padded to a power of two) and the sibling path of `index`.
pub fn bor_tree(leaves: &[B256], index: usize) -> (B256, Vec<B256>) {
    let mut level = leaves.to_vec();
    level.resize(leaves.len().next_power_of_two(), B256::ZERO);
    let (mut i, mut path) = (index, Vec::new());
    while level.len() > 1 {
        path.push(level[i ^ 1]);
        level = level.chunks(2).map(|p| hash_pair(p[0], p[1])).collect();
        i /= 2;
    }
    (level[0], path)
}

/// Checks `h` sits at `h.number - start` in the checkpoint [start, end] with Merkle root `root`.
pub fn verify_bor_inclusion(h: &BorHeader, start: u64, end: u64, root: B256, path: &[B256]) -> bool {
    if h.number < start || h.number > end || path.len() != ((end - start + 1) as usize).next_power_of_two().trailing_zeros() as usize {
        return false;
    }
    let (mut node, mut i) = (bor_leaf(h), h.number - start);
    for sibling in path {
        node = if i & 1 == 0 { hash_pair(node, *sibling) } else { hash_pair(*sibling, node) };
        i >>= 1;
    }
    node == root
}

/// RootChain account and storage proofs for `headerBlocks[id]`'s root, start and end, under an Ethereum state root.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CheckpointProof {
    pub header_block_id: U256,
    pub root: B256,
    pub start: u64,
    pub end: u64,
    pub account_rlp: Vec<u8>,
    pub account_proof: Vec<Vec<u8>>,
    pub storage_proofs: [Vec<Vec<u8>>; 3],
}

pub fn verify_checkpoint(state_root: B256, p: &CheckpointProof) -> bool {
    let nodes = |proof: &[Vec<u8>]| proof.iter().map(|n| n.clone().into()).collect::<Vec<Bytes>>();
    let account_key = Nibbles::unpack(keccak256(ROOT_CHAIN));
    if verify_proof(state_root, account_key, Some(p.account_rlp.clone()), nodes(&p.account_proof).iter()).is_err() {
        return false;
    }
    let sroot = storage_root(&p.account_rlp);
    let base = U256::from_be_bytes(mapping_slot(B256::from(p.header_block_id), HEADER_BLOCKS_SLOT).0);
    let values = [U256::from_be_bytes(p.root.0), U256::from(p.start), U256::from(p.end)];
    values.iter().zip(&p.storage_proofs).enumerate().all(|(i, (value, proof))| {
        let key = Nibbles::unpack(keccak256(B256::from(base + U256::from(i))));
        let expected = (!value.is_zero()).then(|| alloy_rlp::encode(value));
        verify_proof(sroot, key, expected, nodes(proof).iter()).is_ok()
    })
}

#[cfg(test)]
mod tests;
