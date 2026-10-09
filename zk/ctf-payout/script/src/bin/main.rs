//! Host: turns `eth_getBlockByNumber` + `eth_getProof` JSON into the guest input, checks it natively, then executes
//! the guest (no proof): `cargo run --release -- --input proof.json --condition 0x...`; `--prove` also writes a
//! Groth16 proof to fixtures/proof-groth16.json.
use alloy_primitives::{keccak256, B256, U256};
use alloy_rpc_types_eth::{Block, EIP1186AccountProofResponse};
use alloy_sol_types::SolType;
use alloy_trie::TrieAccount;
use clap::Parser;
use ctf_payout_lib::{verify, PayoutInput, PayoutPublicValues};
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, include_elf, Elf, HashableKey, ProvingKey, SP1Stdin};

const ELF: Elf = include_elf!("ctf-payout-program");

#[derive(Parser)]
struct Args {
    #[arg(long)]
    input: String,
    #[arg(long)]
    condition: B256,
    #[arg(long)]
    prove: bool,
}

#[derive(serde::Deserialize)]
struct Fetched {
    block: Block,
    proof: EIP1186AccountProofResponse,
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    let f: Fetched = serde_json::from_str(&std::fs::read_to_string(&args.input).expect("input file")).expect("block + proof json");

    let header_rlp = alloy_rlp::encode(&f.block.header.inner);
    assert_eq!(keccak256(&header_rlp), f.block.header.hash, "rebuilt header does not hash to the block hash");

    let p = &f.proof;
    let account = TrieAccount { nonce: p.nonce, balance: p.balance, storage_root: p.storage_hash, code_hash: p.code_hash };
    let values: Vec<U256> = p.storage_proof.iter().map(|s| s.value).collect();
    let input = PayoutInput {
        header_rlp,
        condition_id: args.condition,
        account_rlp: alloy_rlp::encode(account),
        account_proof: p.account_proof.iter().map(|b| b.to_vec()).collect(),
        values: values.try_into().expect("four storage values"),
        storage_proofs: p.storage_proof.iter().map(|s| s.proof.iter().map(|b| b.to_vec()).collect()).collect::<Vec<_>>().try_into().expect("four storage proofs"),
    };
    let native = verify(&input);
    println!("native check: block {} denominator {} numerators [{}, {}]", native.blockHash, native.denominator, native.numerator0, native.numerator1);

    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    let client = ProverClient::from_env();
    let (output, report) = client.execute(ELF, stdin.clone()).run().expect("guest execution");
    let committed = PayoutPublicValues::abi_decode(output.as_slice()).expect("public values");
    assert_eq!(committed.blockHash, native.blockHash);
    println!("guest committed {} bytes, block {} numerators [{}, {}]; {} cycles", output.as_slice().len(), committed.blockHash, committed.numerator0, committed.numerator1, report.total_instruction_count());

    if args.prove {
        let pk = client.setup(ELF).expect("setup");
        let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof");
        let fixture = serde_json::json!({
            "vkey": pk.verifying_key().bytes32(),
            "publicValues": format!("0x{}", alloy_primitives::hex::encode(proof.public_values.as_slice())),
            "proof": format!("0x{}", alloy_primitives::hex::encode(proof.bytes())),
        });
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/proof-groth16.json");
        std::fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap()).expect("write proof");
        println!("groth16 proof written to {}", path.display());
    }
}
