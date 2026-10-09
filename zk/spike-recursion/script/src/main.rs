//! Host: proves the inner guest compressed, feeds it to the outer guest via write_proof, wraps the outer in Groth16.
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, include_elf, Elf, HashableKey, ProvingKey, SP1Proof, SP1Stdin};
use std::time::Instant;

const INNER: Elf = include_elf!("spike-inner");
const OUTER: Elf = include_elf!("spike-outer");

fn main() {
    sp1_sdk::utils::setup_logger();
    let client = ProverClient::from_env();

    let mut stdin = SP1Stdin::new();
    stdin.write(&42u32);
    let (_, report) = client.execute(INNER, stdin.clone()).run().expect("inner execute");
    println!("inner cycles: {}", report.total_instruction_count());
    let inner_pk = client.setup(INNER).expect("inner setup");
    let t = Instant::now();
    let inner = client.prove(&inner_pk, stdin).compressed().run().expect("inner compressed proof");
    println!("inner compressed proof: {:?}", t.elapsed());
    let inner_vk = inner_pk.verifying_key();
    let SP1Proof::Compressed(proof) = inner.proof else { panic!("not compressed") };

    let mut stdin = SP1Stdin::new();
    stdin.write(&inner_vk.hash_u32());
    stdin.write(&inner.public_values.to_vec());
    stdin.write_proof(*proof, inner_vk.vk.clone());
    let (out, report) = client.execute(OUTER, stdin.clone()).run().expect("outer execute");
    let pv = hex::encode(out.as_slice());
    println!("outer cycles: {}\nouter publicValues: 0x{pv}", report.total_instruction_count());
    let outer_pk = client.setup(OUTER).expect("outer setup");
    println!("outer vkey: {}\ninner vkey: {}", outer_pk.verifying_key().bytes32(), inner_vk.bytes32());
    if std::env::args().any(|a| a == "--execute-only") {
        return;
    }
    let t = Instant::now();
    let proof = client.prove(&outer_pk, stdin).groth16().run();
    println!("outer groth16: {:?} ok={}", t.elapsed(), proof.is_ok());
    let proof = proof.expect("outer groth16 proof");
    let fixture = serde_json::json!({
        "vkey": outer_pk.verifying_key().bytes32(),
        "publicValues": format!("0x{}", hex::encode(proof.public_values.as_slice())),
        "proof": format!("0x{}", hex::encode(proof.bytes())),
    });
    std::fs::write("recursion-groth16.json", serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
}
