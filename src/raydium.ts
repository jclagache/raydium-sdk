import { Provider } from "@coral-xyz/anchor";
import { BasicPoolInfo, JupTokenType, Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { Commitment, Finality, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "./types.js";
import { DEFAULT_COMMITMENT, DEFAULT_FINALITY} from "./util.js";
import { TOKEN_WSOL } from "@raydium-io/raydium-sdk-v2";
import { TokenAmount, toToken } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { join } from "path";
import fs from "fs";
import jsonfile from "jsonfile";
import { fileURLToPath } from 'url';
import { dirname } from 'path';



export class RaydiumSDK {
  public program!: Raydium;
  private cachePools: CachePools | null = null;
  constructor(provider: Provider, cachePools?: CachePools) {
    if (!provider.wallet) {
      throw new Error("Provider wallet is undefined");
    }
    this.cachePools = cachePools ?? null;
    // Initialize Raydium asynchronously
    Raydium.load({
      connection: provider.connection,
      owner: provider.wallet.publicKey,
      cluster: "mainnet",
      jupTokenType: JupTokenType.ALL
    }).then((instance) => {
      this.program = instance;
    });
  }

  /**
 * Not implemented: Create a token and buy it in one call.
 * @throws Error always, as this method is not implemented.
 */
  async createAndBuyToken(
    sdk: RaydiumSDK,
    testAccount: Keypair,
    mint: PublicKey,
    tokenMetadata: any,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint,
    priorityFees?: PriorityFee
  ): Promise<never> {
    // Always throw an error to indicate this method is not implemented
    throw new Error("createAndBuyToken is not implemented.");
  }

  /**
   * Buy a SPL token using SOL via Raydium swap.
   */
  async buy(
    buyer: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    // 1. Get WSOL mint address (Raydium uses WSOL for SOL swaps)
    const wsolMint = new PublicKey(TOKEN_WSOL.address);

    // 2. Load token info for output mint
    const outputTokenInfo = await this.program.token.getTokenInfo(mint);

    // 3. Fetch all available swap routes
    // strongly recommend cache all pool data, it will reduce lots of data fetching time
    // code below is a simple way to cache it, you can implement it with any other ways
    const poolCache = this.cachePools ?? FilePoolCache.getInstance();
    let poolData = poolCache.pools;
    if (!poolData) {
      console.log(
        '**Please ensure you are using "paid" rpc node or you might encounter fetch data error due to pretty large pool data**'
      )
      poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo()
      poolCache.setPools(poolData);
    }
    const allRoutes = this.program.tradeV2.getAllRoute({
      inputMint: wsolMint,
      outputMint: mint,
      clmmPools: poolData.clmmPools,
      ammPools: poolData.ammPools,
      cpmmPools: poolData.cpmmPools,
    });

    // 4. Fetch route simulation data
    const swapRoutesData = await this.program.tradeV2.fetchSwapRoutesData({
      routes: allRoutes,
      inputMint: wsolMint,
      outputMint: mint,
    });

    // 5. Prepare input amount as TokenAmount
    const inputTokenInfo = await this.program.token.getTokenInfo(wsolMint);
    const inputTokenAmount = new TokenAmount(
      toToken(inputTokenInfo),
      buyAmountSol.toString()
    );

    // 6. Compute best route and minAmountOut with slippage
    const epochInfo = await this.program.connection.getEpochInfo();
    const chainTime = Date.now(); // or fetch from chain if needed
    const slippage = Number(slippageBasisPoints) / 10000; // e.g. 500 = 5%
    const computeAmountOuts = this.program.tradeV2.getAllRouteComputeAmountOut({
      inputTokenAmount,
      outputToken: outputTokenInfo,
      directPath: swapRoutesData.routePathDict[outputTokenInfo.address]?.in ?? [],
      routePathDict: swapRoutesData.routePathDict,
      simulateCache: swapRoutesData.ammSimulateCache,
      tickCache: swapRoutesData.computePoolTickData,
      mintInfos: swapRoutesData.mintInfos,
      slippage,
      chainTime,
      epochInfo,
    });

    if (!computeAmountOuts.length) throw new Error("No swap route found");

    // 7. Select the best route (highest minAmountOut)
    const bestRoute = computeAmountOuts.reduce((a, b) =>
      a.minAmountOut.amount.gt(b.minAmountOut.amount) ? a : b
    );

    // 8. Get pool keys for the route
    const poolKeys = await this.program.tradeV2.computePoolToPoolKeys({
      pools: bestRoute.poolInfoList,
      clmmRpcData: swapRoutesData.clmmPoolsRpcInfo,
      ammRpcData: swapRoutesData.ammPoolsRpcInfo,
    });

    // 9. Build the swap transaction
    const swapTxData = await this.program.tradeV2.swap({
      txVersion: TxVersion.V0, // 0 = legacy, 1 = v0
      swapInfo: bestRoute,
      swapPoolKeys: poolKeys,
      ownerInfo: {
        associatedOnly: true,
        checkCreateATAOwner: true,
      },
      routeProgram: new PublicKey(poolKeys[0].id),
      feePayer: buyer.publicKey,
    });

    // 10. Sign and send the transaction
    const tx = swapTxData.transactions[0];
    const signature = await this.program.connection.sendRawTransaction(
      tx.serialize(),
      { skipPreflight: false, preflightCommitment: commitment }
    );

    // 11. Return the transaction result
    return {
      success: true,
      signature,
    };
  }

  /**
   * Sell a SPL token for SOL via Raydium swap.
   */
  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    // 1. Get WSOL mint address (Raydium uses WSOL for SOL swaps)
    const wsolMint = new PublicKey(TOKEN_WSOL.address);

    // 2. Load token info for input mint (SPL token)
    const inputTokenInfo = await this.program.token.getTokenInfo(mint);

    // 3. Fetch all available swap routes
    // strongly recommend cache all pool data, it will reduce lots of data fetching time
    // code below is a simple way to cache it, you can implement it with any other ways
    const poolCache = this.cachePools ?? FilePoolCache.getInstance();
    let poolData = poolCache.pools;
    if (!poolData) {
      console.log(
        '**Please ensure you are using "paid" rpc node or you might encounter fetch data error due to pretty large pool data**'
      )
      poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo()
      poolCache.setPools(poolData);
    }
    const allRoutes = this.program.tradeV2.getAllRoute({
      inputMint: mint,
      outputMint: wsolMint,
      clmmPools: poolData.clmmPools,
      ammPools: poolData.ammPools,
      cpmmPools: poolData.cpmmPools,
    });

    // 4. Fetch route simulation data
    const swapRoutesData = await this.program.tradeV2.fetchSwapRoutesData({
      routes: allRoutes,
      inputMint: mint,
      outputMint: wsolMint,
    });

    // 5. Prepare input amount as TokenAmount
    const inputTokenAmount = new TokenAmount(
      toToken(inputTokenInfo),
      sellTokenAmount.toString()
    );

    // 6. Compute best route and minAmountOut with slippage
    const epochInfo = await this.program.connection.getEpochInfo();
    const chainTime = Date.now(); // or fetch from chain if needed
    const slippage = Number(slippageBasisPoints) / 10000; // e.g. 500 = 5%
    const outputTokenInfo = await this.program.token.getTokenInfo(wsolMint);
    const computeAmountOuts = this.program.tradeV2.getAllRouteComputeAmountOut({
      inputTokenAmount,
      outputToken: outputTokenInfo,
      directPath: swapRoutesData.routePathDict[outputTokenInfo.address]?.in ?? [],
      routePathDict: swapRoutesData.routePathDict,
      simulateCache: swapRoutesData.ammSimulateCache,
      tickCache: swapRoutesData.computePoolTickData,
      mintInfos: swapRoutesData.mintInfos,
      slippage,
      chainTime,
      epochInfo,
    });

    if (!computeAmountOuts.length) throw new Error("No swap route found");

    // 7. Select the best route (highest minAmountOut)
    const bestRoute = computeAmountOuts.reduce((a, b) =>
      a.minAmountOut.amount.gt(b.minAmountOut.amount) ? a : b
    );

    // 8. Get pool keys for the route
    const poolKeys = await this.program.tradeV2.computePoolToPoolKeys({
      pools: bestRoute.poolInfoList,
      clmmRpcData: swapRoutesData.clmmPoolsRpcInfo,
      ammRpcData: swapRoutesData.ammPoolsRpcInfo,
    });

    // 9. Build the swap transaction
    const swapTxData = await this.program.tradeV2.swap({
      txVersion: TxVersion.V0 , // 0 = legacy, 1 = v0
      swapInfo: bestRoute,
      swapPoolKeys: poolKeys,
      ownerInfo: {
        associatedOnly: true,
        checkCreateATAOwner: true,
      },
      routeProgram: new PublicKey(poolKeys[0].id),
      feePayer: seller.publicKey,
    });

    // 10. Sign and send the transaction
    const tx = swapTxData.transactions[0];
    const signature = await this.program.connection.sendRawTransaction(
      tx.serialize(),
      { skipPreflight: false, preflightCommitment: commitment }
    );

    // 11. Return the transaction result
    return {
      success: true,
      signature,
    };
  }

  /**
   * Buy a SPL token with SOL, then immediately sell it back to SOL.
   * Useful for arbitrage or testing.
   */
  async buyAndSell(
    buyerSeller: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    // 1. Buy the SPL token with SOL
    const buyResult = await this.buy(
      buyerSeller,
      mint,
      buyAmountSol,
      slippageBasisPoints,
      priorityFees,
      commitment,
      finality
    );

    // 2. Fetch the actual SPL token balance after the buy
    const ata = await getAssociatedTokenAddress(
      mint,
      buyerSeller.publicKey
    );
    const accountInfo = await getAccount(
      this.program.connection,
      ata,
      commitment
    );
    const amountToSell = BigInt(accountInfo.amount.toString());

    // 3. Sell the SPL token back to SOL
    const sellResult = await this.sell(
      buyerSeller,
      mint,
      amountToSell,
      slippageBasisPoints,
      priorityFees,
      commitment,
      finality
    );

    // 4. Return a combined result (only allowed TransactionResult fields)
    return {
      success: sellResult.success && buyResult.success,
      signature: sellResult.signature, // or return both signatures if you update the type
    };
  }

  /**
   * Check if a SPL token is tradable on Raydium by verifying if swap routes exist.
   * @param mint The SPL token mint address to check
   * @param connection The Solana connection to use
   * @returns Promise<boolean> True if the token is tradable, false otherwise
   */
  static async isTradable(mint: PublicKey, connection: Connection, cachePools?: CachePools): Promise<boolean> {
    try {
      // Get WSOL mint address (Raydium uses WSOL for SOL swaps)
      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      // Initialize Raydium instance
      const raydium = await Raydium.load({
        connection,
        cluster: "mainnet",
        jupTokenType: JupTokenType.ALL
      });
      // Fetch all available swap routes
      // strongly recommend cache all pool data, it will reduce lots of data fetching time
      // code below is a simple way to cache it, you can implement it with any other ways
      const poolCache = cachePools ?? FilePoolCache.getInstance();
      let poolData = poolCache.pools;
      if (!poolData) {
        console.log(
          '**Please ensure you are using "paid" rpc node or you might encounter fetch data error due to pretty large pool data**'
        )
        poolData = await raydium.tradeV2.fetchRoutePoolBasicInfo()
        poolCache.setPools(poolData);
      }
      // Check routes in both directions (SOL -> Token and Token -> SOL)
      const routesToToken = raydium.tradeV2.getAllRoute({
        inputMint: wsolMint,
        outputMint: mint,
        clmmPools: poolData.clmmPools,
        ammPools: poolData.ammPools,
        cpmmPools: poolData.cpmmPools,
      });      
      const routesToSol = raydium.tradeV2.getAllRoute({
        inputMint: mint,
        outputMint: wsolMint,
        clmmPools: poolData.clmmPools,
        ammPools: poolData.ammPools,
        cpmmPools: poolData.cpmmPools,
      });
      // Token is tradable if there are valid routes in either direction
      const isTradable = (Object.keys(routesToToken.directPath).length > 0 || Object.keys(routesToToken.routePathDict).length > 0) &&
        (Object.keys(routesToSol.directPath).length > 0 || Object.keys(routesToSol.routePathDict).length > 0);
      return isTradable;
    } catch (error) {
      console.error('Error checking if token is tradable:', error);
      return false;
    }
  }
}

export interface CachePools {
  pools: {
    ammPools: BasicPoolInfo[];
    clmmPools: BasicPoolInfo[];
    cpmmPools: BasicPoolInfo[];
  } | null;
  setPools: (pools: {
    ammPools: BasicPoolInfo[];
    clmmPools: BasicPoolInfo[];
    cpmmPools: BasicPoolInfo[];
  }) => void;
}


// Private implementation of CachePools interface
class FilePoolCache implements CachePools {
  private static instance: FilePoolCache;
  private readonly filePath: string;
  private readonly cacheTime: number = 1000 * 60 * 60 * 24; // 24 hours

  private constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    this.filePath = join(__dirname, '../data/pool_data.json');
  }

  private isCacheValid(data: { time: number }): boolean {
    return Date.now() - data.time <= this.cacheTime;
  }

  static getInstance(): FilePoolCache {
    if (!FilePoolCache.instance) {
      FilePoolCache.instance = new FilePoolCache();
    }
    return FilePoolCache.instance;
  }

  get pools(): {
    ammPools: BasicPoolInfo[];
    clmmPools: BasicPoolInfo[];
    cpmmPools: BasicPoolInfo[];
  } | null {
    try {
      console.log('reading cache pool data')
      const data = jsonfile.readFileSync(this.filePath) as {
        time: number
        ammPools: BasicPoolInfo[]
        clmmPools: BasicPoolInfo[]
        cpmmPools: BasicPoolInfo[]
      }
      if (!this.isCacheValid(data)) {
        console.log('cache data expired')
        return null
      }
      return {
        ammPools: data.ammPools.map((p) => ({
          ...p,
          id: new PublicKey(p.id),
          mintA: new PublicKey(p.mintA),
          mintB: new PublicKey(p.mintB),
        })),
        clmmPools: data.clmmPools.map((p) => ({
          ...p,
          id: new PublicKey(p.id),
          mintA: new PublicKey(p.mintA),
          mintB: new PublicKey(p.mintB),
        })),
        cpmmPools: data.cpmmPools.map((p) => ({
          ...p,
          id: new PublicKey(p.id),
          mintA: new PublicKey(p.mintA),
          mintB: new PublicKey(p.mintB),
        })),
      }
    } catch {
      console.log('cannot read cache pool data')
      return null
    }
  }

  setPools(pools: {
    ammPools: BasicPoolInfo[];
    clmmPools: BasicPoolInfo[];
    cpmmPools: BasicPoolInfo[];
  }): void {
    console.log('caching all pool basic info..')
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    fs.mkdir(join(__dirname, '../data'), (err) => {
      if (err) {
        return console.error(err)
      }
    })
  
    // Process pools in chunks to reduce memory usage
    const processChunk = (pools: BasicPoolInfo[]) => {
      return pools.map((p) => ({
        id: p.id.toBase58(),
        version: p.version,
        mintA: p.mintA.toBase58(),
        mintB: p.mintB.toBase58(),
      }));
    };
  
    const processedData = {
      time: Date.now(),
      ammPools: processChunk(pools.ammPools),
      clmmPools: processChunk(pools.clmmPools),
      cpmmPools: processChunk(pools.cpmmPools),
    };
  
    jsonfile
      .writeFile(this.filePath, processedData)
      .then(() => {
        console.log('cache pool data success')
      })
      .catch((e) => {
        console.log('cache pool data failed', e)
      })
  }
}
