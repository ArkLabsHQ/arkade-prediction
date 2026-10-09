//! Guest: verifies a CTF payout against a Polygon block and commits it ABI-encoded (5 words, 160 bytes).
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::SolType;
use ctf_payout_lib::{verify, PayoutInput, PayoutPublicValues};

pub fn main() {
    let input: PayoutInput = sp1_zkvm::io::read();
    let out = verify(&input);
    sp1_zkvm::io::commit_slice(&PayoutPublicValues::abi_encode(&out));
}
