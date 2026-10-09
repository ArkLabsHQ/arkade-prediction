//! Inner guest: commits n (u32 BE) || sha256("arkade" || n), 36 bytes.
#![no_main]
sp1_zkvm::entrypoint!(main);
use sha2::{Digest, Sha256};

pub fn main() {
    let n: u32 = sp1_zkvm::io::read();
    let h: [u8; 32] = Sha256::new().chain_update(b"arkade").chain_update(n.to_be_bytes()).finalize().into();
    sp1_zkvm::io::commit_slice(&n.to_be_bytes());
    sp1_zkvm::io::commit_slice(&h);
}
