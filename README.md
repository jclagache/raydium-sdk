# Raydium SDK

This SDK provides a high-level interface to interact with Raydium pools and perform token swaps on Solana, with a focus on SOL <-> SPL token operations.

---

## Features

- **Buy SPL tokens with SOL** via Raydium swap
- **Sell SPL tokens for SOL** via Raydium swap
- **Buy and immediately sell** (arbitrage/test) with actual on-chain balance
- Secure, efficient, and maintainable code following Solana and Anchor best practices

---

## Installation

```sh
npm install @raydium-io/raydium-sdk-v2 @solana/web3.js @solana/spl-token @coral-xyz/anchor
```

---

## Usage

### Initialization

```js
import { RaydiumSDK } from './src/raydium';
import { Provider } from '@coral-xyz/anchor';

const provider = /* your Anchor provider */;
const sdk = new RaydiumSDK(provider);
```

---

### Buy SPL Token with SOL

```js
const result = await sdk.buy(
  buyerKeypair,
  mint, // SPL token mint (PublicKey)
  BigInt(0.1 * LAMPORTS_PER_SOL), // Amount in SOL (as bigint, in lamports)
  500n // Slippage in basis points (optional, default 500 = 5%)
);
console.log(result); // { success: true, signature }
```

---

### Sell SPL Token for SOL

```js
const result = await sdk.sell(
  sellerKeypair,
  mint, // SPL token mint (PublicKey)
  amountToSell, // Amount of SPL token to sell (as bigint)
  500n // Slippage in basis points (optional)
);
console.log(result); // { success: true, signature }
```

---

### Buy and Immediately Sell (Arbitrage/Test)

This method will:
- Buy the SPL token with SOL
- Fetch the actual on-chain balance of the SPL token after the buy
- Sell the entire received amount back to SOL

```js
const result = await sdk.buyAndSell(
  keypair,
  mint, // SPL token mint (PublicKey)
  BigInt(0.1 * LAMPORTS_PER_SOL), // Amount in SOL
  500n // Slippage in basis points (optional)
);
console.log(result); // { success: true, signature }
```

---

### Not Implemented: createAndBuyToken

```js
const createAndBuyToken = async (sdk, testAccount, mint) => {
  const tokenMetadata = {
    name: "TST-7",
    symbol: "TST-7",
    description: "TST-7: This is a test token",
    filePath: "example/basic/random.png",
  };

  // ⚠️ Not implemented: This method will throw an error if called.
  // See RaydiumSDK.createAndBuyToken for details.
  await sdk.createAndBuyToken(
    testAccount,
    mint,
    tokenMetadata,
    BigInt(0.0001 * LAMPORTS_PER_SOL),
    500n,
    {
      unitLimit: 250000,
      unitPrice: 250000,
    }
  );
};
```

> **Note:**  
> The `createAndBuyToken` method is **not implemented** in the SDK and will throw an error if called.  
> If you need this feature, please open an issue or contribute an implementation.

---

## Project Structure

- `src/raydium.ts` — Main SDK logic (buy, sell, buyAndSell, etc.)
- `src/types.ts` — Type definitions
- `src/util.ts` — Utility functions
- `src/index.ts` — Entry point

---

## Build

The SDK uses Rollup for bundling.  
The `external` array in `rollup.config.js` includes only the libraries actually used:

```js
const external = [
  "@solana/web3.js",
  "@solana/spl-token",
  "@coral-xyz/anchor",
  "@raydium-io/raydium-sdk-v2"
];
```

---

## Notes

- The SDK does **not** bundle `@raydium-io/raydium-sdk-v2` or Solana libraries; you must install them as peer dependencies.
- All code is written with security, performance, and maintainability in mind, following Solana and Anchor best practices.
- The SDK fetches the actual on-chain SPL token balance after a buy to ensure the correct amount is sold in `buyAndSell`.

---

## License

MIT
