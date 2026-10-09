# ctf-payout (SP1)

Proves a Polymarket CTF payout from Polygon state: the CTF account and its `payoutDenominator` /
`payoutNumerators` storage slots are verified against the state root of a block header, and the guest commits
`abi.encode(blockHash, conditionId, denominator, numerator0, numerator1)` (160 bytes). The block hash is not yet
anchored to a light client; that link (Ethereum light client, Polygon checkpoint) is still open.

Linux or WSL with the SP1 toolchain (`sp1up`) and `protoc`:

```sh
cd script
cargo run --release -- --input ../fixtures/buccaneers-cowboys.json \
  --condition 0xd43898f7e10c30da1adf9c23c808fc8861ec7c0a53195e4a187c199a9b19f376
```

The fixture is `eth_getBlockByNumber` + `eth_getProof` for the CTF at a finalized Polygon block; storage keys are
the denominator, the numerators length and the two numerators, in that order.
