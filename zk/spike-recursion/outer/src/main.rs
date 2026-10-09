//! Outer guest: verifies the inner compressed proof, commits abi.encode(innerVkey, innerHash, n, 2n, 1) (160 bytes).
#![no_main]
sp1_zkvm::entrypoint!(main);
use sha2::{Digest, Sha256};

pub fn main() {
    let vkey: [u32; 8] = sp1_zkvm::io::read();
    let pv: Vec<u8> = sp1_zkvm::io::read();
    let pv_digest: [u8; 32] = Sha256::digest(&pv).into();
    sp1_zkvm::lib::verify::verify_sp1_proof(&vkey, &pv_digest);

    let n = u32::from_be_bytes(pv[..4].try_into().unwrap());
    let mut out = [0u8; 160];
    for (i, w) in vkey.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    out[32..64].copy_from_slice(&pv[4..36]);
    out[92..96].copy_from_slice(&n.to_be_bytes());
    out[124..128].copy_from_slice(&(n * 2).to_be_bytes());
    out[159] = 1;
    sp1_zkvm::io::commit_slice(&out);
}
