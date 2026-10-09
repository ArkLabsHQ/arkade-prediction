use super::*;
use serde_json::Value;

const CONDITION: B256 = B256::new(hex_literal::hex!("d43898f7e10c30da1adf9c23c808fc8861ec7c0a53195e4a187c199a9b19f376"));
const TX_INDEX: usize = 48;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/buccaneers-resolution.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    alloy_primitives::hex::decode(v.as_str().unwrap()).unwrap()
}
fn b256(v: &Value) -> B256 {
    B256::from_slice(&bytes(v))
}
fn num(v: &Value) -> u64 {
    match v {
        Value::String(s) if s.starts_with("0x") => u64::from_str_radix(&s[2..], 16).unwrap(),
        Value::String(s) => s.parse().unwrap(),
        _ => v.as_u64().unwrap(),
    }
}
fn flip<T: AsMut<[u8]>>(mut v: T, byte: usize) -> T {
    v.as_mut()[byte] ^= 1;
    v
}
fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload = items.concat();
    let mut out = Vec::new();
    Header { list: true, payload_length: payload.len() }.encode(&mut out);
    out.extend(payload);
    out
}

fn encode_receipt(r: &Value) -> Vec<u8> {
    let logs: Vec<Vec<u8>> = r["logs"].as_array().unwrap().iter().map(|l| {
        let topics: Vec<B256> = l["topics"].as_array().unwrap().iter().map(b256).collect();
        rlp_list(&[alloy_rlp::encode(Address::from_slice(&bytes(&l["address"]))), alloy_rlp::encode(topics), alloy_rlp::encode(Bytes::from(bytes(&l["data"])))])
    }).collect();
    let body = rlp_list(&[alloy_rlp::encode(num(&r["status"])), alloy_rlp::encode(num(&r["cumulativeGasUsed"])), alloy_rlp::encode(Bytes::from(bytes(&r["logsBloom"]))), rlp_list(&logs)]);
    match num(&r["type"]) {
        0 => body,
        t => [vec![t as u8], body].concat(),
    }
}

#[test]
fn receipt_proves_condition_resolution() {
    let f = fixture();
    let receipts: Vec<Vec<u8>> = f["receipts"].as_array().unwrap().iter().map(encode_receipt).collect();
    assert_eq!(num(&f["receipts"][TX_INDEX]["transactionIndex"]), TX_INDEX as u64);
    let root = b256(&f["block"]["receiptsRoot"]);
    let (rebuilt, proof) = receipt_trie(&receipts, TX_INDEX);
    assert_eq!(rebuilt, root, "receiptsRoot");

    let receipt = &receipts[TX_INDEX];
    assert!(verify_receipt(root, TX_INDEX, receipt, &proof));
    assert_eq!(condition_payout(receipt, CONDITION), Some((vec![U256::from(1), U256::ZERO], U256::from(1))));
    assert_eq!(ConditionResolution::SIGNATURE_HASH, B256::new(hex_literal::hex!("b44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894")));

    assert!(!verify_receipt(root, TX_INDEX, &flip(receipt.clone(), receipt.len() - 1), &proof));
    assert!(!verify_receipt(flip(root, 0), TX_INDEX, receipt, &proof));
    assert!(!verify_receipt(root, TX_INDEX + 1, receipt, &proof));
    let mut bad = proof.clone();
    bad[1] = flip(bad[1].clone(), 40);
    assert!(!verify_receipt(root, TX_INDEX, receipt, &bad));
    assert_eq!(condition_payout(receipt, flip(CONDITION, 31)), None);
}

#[test]
fn block_is_in_checkpoint() {
    let f = fixture();
    let cp = &f["checkpoint"];
    let (start, end, root) = (num(&cp["start"]), num(&cp["end"]), b256(&cp["root"]));
    let headers: Vec<BorHeader> = f["headers"].as_array().unwrap().iter().map(|h| BorHeader {
        number: num(&h["number"]),
        time: num(&h["timestamp"]),
        tx_root: b256(&h["transactionsRoot"]),
        receipt_root: b256(&h["receiptsRoot"]),
    }).collect();
    assert_eq!(headers.len() as u64, end - start + 1);
    let index = (num(&f["block"]["number"]) - start) as usize;
    let h = headers[index];
    assert_eq!(h.receipt_root, b256(&f["block"]["receiptsRoot"]));

    let (rebuilt, path) = bor_tree(&headers.iter().map(bor_leaf).collect::<Vec<_>>(), index);
    assert_eq!(rebuilt, root, "checkpoint root");
    assert!(verify_bor_inclusion(&h, start, end, root, &path));

    assert!(!verify_bor_inclusion(&BorHeader { receipt_root: flip(h.receipt_root, 0), ..h }, start, end, root, &path));
    assert!(!verify_bor_inclusion(&BorHeader { number: h.number ^ 1, ..h }, start, end, root, &path));
    let mut bad = path.clone();
    bad[0] = flip(bad[0], 31);
    assert!(!verify_bor_inclusion(&h, start, end, root, &bad));
    assert!(!verify_bor_inclusion(&h, start, end, flip(root, 0), &path));
}

#[test]
fn checkpoint_is_in_root_chain() {
    let f = fixture();
    let (cp, p) = (&f["checkpoint"], &f["ethereum"]["proof"]);
    let proofs = |v: &Value| v.as_array().unwrap().iter().map(bytes).collect::<Vec<_>>();
    let balance = U256::from_str_radix(&p["balance"].as_str().unwrap()[2..], 16).unwrap();
    let account = rlp_list(&[alloy_rlp::encode(num(&p["nonce"])), alloy_rlp::encode(balance), alloy_rlp::encode(b256(&p["storageHash"])), alloy_rlp::encode(b256(&p["codeHash"]))]);
    let proof = CheckpointProof {
        header_block_id: U256::from(num(&cp["headerBlockId"])),
        root: b256(&cp["root"]),
        start: num(&cp["start"]),
        end: num(&cp["end"]),
        account_rlp: account,
        account_proof: proofs(&p["accountProof"]),
        storage_proofs: core::array::from_fn(|i| proofs(&p["storageProof"][i]["proof"])),
    };
    let state_root = b256(&f["ethereum"]["stateRoot"]);
    assert!(verify_checkpoint(state_root, &proof));

    assert!(!verify_checkpoint(flip(state_root, 0), &proof));
    assert!(!verify_checkpoint(state_root, &CheckpointProof { root: flip(proof.root, 31), ..proof.clone() }));
    assert!(!verify_checkpoint(state_root, &CheckpointProof { start: proof.start ^ 1, ..proof.clone() }));
    assert!(!verify_checkpoint(state_root, &CheckpointProof { header_block_id: proof.header_block_id ^ U256::from(1), ..proof.clone() }));
}
