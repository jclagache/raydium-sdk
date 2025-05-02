import { Provider } from "@coral-xyz/anchor";
import { BasicPoolInfo, JupTokenType, Raydium, TxVersion, Token, ApiV3Token, toApiV3Token } from "@raydium-io/raydium-sdk-v2";
import { Commitment, Finality, Keypair, PublicKey } from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "./types.js";
import { DEFAULT_COMMITMENT, DEFAULT_FINALITY, getProjectPath } from "./util.js";
import { TOKEN_WSOL } from "@raydium-io/raydium-sdk-v2";
import { TokenAmount, toToken } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import path from "path";
import fs from "fs";
import jsonfile from "jsonfile";

export class RaydiumSDK {
  public program!: Raydium;
  private cachePools: CachePools | null = null;
  constructor(provider: Provider, cachePools?: CachePools) {
    if (!provider.wallet) {
      throw new Error("Provider wallet is undefined");
    }
    this.cachePools = cachePools ?? null;
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
    throw new Error("createAndBuyToken is not implemented.");
  }

  /**
   * Buy a SPL token using SOL via Raydium swap.
   */
  async buy(
    buyer: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints = BigInt(500),
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    const wsolMint = new PublicKey(TOKEN_WSOL.address);
    const inputMint = wsolMint;
    const outputMint = mint;
    
    try {
      await this.program.fetchChainTime();
      
      const inputMintStr = inputMint.toBase58();
      const outputMintStr = outputMint.toBase58();
      
      const poolCache = this.cachePools ?? FilePoolCache.getInstance();
      let poolData = poolCache.pools;
      
      if (!poolData) {
        poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo();
        poolCache.setPools(poolData);
      }
      
      const routes = this.program.tradeV2.getAllRoute({
        inputMint,
        outputMint,
        ...poolData
      });
      
      if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
        throw new Error(`No swap route found between ${inputMintStr} and ${outputMintStr}`);
      }
      
      const { 
        routePathDict, 
        mintInfos, 
        ammPoolsRpcInfo, 
        ammSimulateCache,
        clmmPoolsRpcInfo, 
        computePoolTickData,
        computeCpmmData
      } = await this.program.tradeV2.fetchSwapRoutesData({
        routes,
        inputMint,
        outputMint
      });
      
      if (!mintInfos[inputMintStr] || !mintInfos[outputMintStr]) {
        throw new Error(`Missing mint info for ${!mintInfos[inputMintStr] ? inputMintStr : outputMintStr}`);
      }
      
      const inputAmount = buyAmountSol.toString();
      
      const inputTokenAmount = new TokenAmount(
        new Token({
          mint: inputMintStr,
          decimals: mintInfos[inputMintStr].decimals,
          isToken2022: mintInfos[inputMintStr].programId.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
        }),
        inputAmount
      );
      
      const slippage = Number(slippageBasisPoints) / 10000;
      const epochInfo = await this.program.connection.getEpochInfo();
      
      const outputTokenApi = toApiV3Token({
        address: outputMintStr,
        programId: mintInfos[outputMintStr].programId.toBase58(),
        decimals: mintInfos[outputMintStr].decimals,
        name: outputMintStr.slice(0, 5),
        symbol: outputMintStr.slice(0, 5),
        logoURI: '',
        chainId: 0
      });

      const swapRoutes = this.program.tradeV2.getAllRouteComputeAmountOut({
        inputTokenAmount,
        directPath: routes.directPath.map(
          (p) => ammSimulateCache[p.id.toBase58()] || 
                computePoolTickData[p.id.toBase58()] || 
                computeCpmmData[p.id.toBase58()]
        ),
        routePathDict,
        simulateCache: ammSimulateCache,
        tickCache: computePoolTickData,
        outputToken: outputTokenApi,
        mintInfos,
        slippage,
        chainTime: Math.floor(this.program.chainTimeData?.chainTime ?? Date.now() / 1000),
        epochInfo
      });
      
      if (!swapRoutes.length) {
        if (buyAmountSol < BigInt(1e8)) {
          console.error(`[BUY] No swap routes found - Try with a larger amount (at least 0.1 SOL)`);
          throw new Error("No swap route found - Amount too small");
        }
        throw new Error("No swap route found");
      }
      
      const targetRoute = swapRoutes[0];
      
      const poolKeys = await this.program.tradeV2.computePoolToPoolKeys({
        pools: targetRoute.poolInfoList,
        ammRpcData: ammPoolsRpcInfo,
        clmmRpcData: clmmPoolsRpcInfo
      });
      
      const swapTxData = await this.program.tradeV2.swap({
        txVersion: TxVersion.V0,
        swapInfo: targetRoute,
        swapPoolKeys: poolKeys,
        ownerInfo: {
          associatedOnly: true,
          checkCreateATAOwner: true,
        },
        routeProgram: new PublicKey(poolKeys[0].id),
        feePayer: buyer.publicKey,
        computeBudgetConfig: {
          units: 600000,
          microLamports: 465915,
        }
      });
      
      const tx = swapTxData.transactions[0];
      const signature = await this.program.connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: false, preflightCommitment: commitment }
      );
      
      return {
        success: true,
        signature
      };
    } catch (error) {
      console.error(`[BUY] Error during swap:`, error);
      throw error;
    }
  }

  /**
   * Sell a SPL token for SOL via Raydium swap.
   */
  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints = BigInt(500),
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    const wsolMint = new PublicKey(TOKEN_WSOL.address);
    const inputMint = mint;
    const outputMint = wsolMint;
    
    try {
      await this.program.fetchChainTime();
      
      const inputMintStr = inputMint.toBase58();
      const outputMintStr = outputMint.toBase58();
      
      const poolCache = this.cachePools ?? FilePoolCache.getInstance();
      let poolData = poolCache.pools;
      
      if (!poolData) {
        poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo();
        poolCache.setPools(poolData);
      }
      
      const routes = this.program.tradeV2.getAllRoute({
        inputMint,
        outputMint,
        ...poolData
      });
      
      if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
        throw new Error(`No swap route found between ${inputMintStr} and ${outputMintStr}`);
      }
      
      const { 
        routePathDict, 
        mintInfos, 
        ammPoolsRpcInfo, 
        ammSimulateCache,
        clmmPoolsRpcInfo, 
        computePoolTickData,
        computeCpmmData
      } = await this.program.tradeV2.fetchSwapRoutesData({
        routes,
        inputMint,
        outputMint
      });
      
      if (!mintInfos[inputMintStr] || !mintInfos[outputMintStr]) {
        throw new Error(`Missing mint info for ${!mintInfos[inputMintStr] ? inputMintStr : outputMintStr}`);
      }
      
      const inputAmount = sellTokenAmount.toString();
      
      const inputTokenAmount = new TokenAmount(
        new Token({
          mint: inputMintStr,
          decimals: mintInfos[inputMintStr].decimals,
          isToken2022: mintInfos[inputMintStr].programId.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
        }),
        inputAmount
      );
      
      const slippage = Number(slippageBasisPoints) / 10000;
      const epochInfo = await this.program.connection.getEpochInfo();
      
      const outputTokenApi = toApiV3Token({
        address: outputMintStr, 
        programId: mintInfos[outputMintStr].programId.toBase58(),
        decimals: mintInfos[outputMintStr].decimals,
        name: outputMintStr.slice(0, 5),
        symbol: outputMintStr.slice(0, 5),
        logoURI: '',
        chainId: 0
      });

      const swapRoutes = this.program.tradeV2.getAllRouteComputeAmountOut({
        inputTokenAmount,
        directPath: routes.directPath.map(
          (p) => ammSimulateCache[p.id.toBase58()] || 
                computePoolTickData[p.id.toBase58()] || 
                computeCpmmData[p.id.toBase58()]
        ),
        routePathDict,
        simulateCache: ammSimulateCache,
        tickCache: computePoolTickData,
        outputToken: outputTokenApi,
        mintInfos,
        slippage,
        chainTime: Math.floor(this.program.chainTimeData?.chainTime ?? Date.now() / 1000),
        epochInfo
      });
      
      if (!swapRoutes.length) {
        throw new Error("No swap route found");
      }
      
      const targetRoute = swapRoutes[0];
      
      const poolKeys = await this.program.tradeV2.computePoolToPoolKeys({
        pools: targetRoute.poolInfoList,
        ammRpcData: ammPoolsRpcInfo,
        clmmRpcData: clmmPoolsRpcInfo
      });
      
      const swapTxData = await this.program.tradeV2.swap({
        txVersion: TxVersion.V0,
        swapInfo: targetRoute,
        swapPoolKeys: poolKeys,
        ownerInfo: {
          associatedOnly: true,
          checkCreateATAOwner: true,
        },
        routeProgram: new PublicKey(poolKeys[0].id),
        feePayer: seller.publicKey,
        computeBudgetConfig: {
          units: 600000,
          microLamports: 465915,
        }
      });
      
      const tx = swapTxData.transactions[0];
      const signature = await this.program.connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: false, preflightCommitment: commitment }
      );
      
      return {
        success: true,
        signature
      };
    } catch (error) {
      console.error(`[SELL] Error during swap:`, error);
      throw error;
    }
  }

  /**
   * Buy a SPL token with SOL, then immediately sell it back to SOL.
   * Useful for arbitrage or testing.
   */
  async buyAndSell(
    buyerSeller: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints = BigInt(500),
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    const buyResult = await this.buy(
      buyerSeller,
      mint,
      buyAmountSol,
      slippageBasisPoints,
      priorityFees,
      commitment,
      finality
    );

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

    const sellResult = await this.sell(
      buyerSeller,
      mint,
      amountToSell,
      slippageBasisPoints,
      priorityFees,
      commitment,
      finality
    );

    return {
      success: sellResult.success && buyResult.success,
      signature: sellResult.signature,
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
      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      const raydium = await Raydium.load({
        connection,
        cluster: "mainnet",
        jupTokenType: JupTokenType.ALL
      });
      
      const poolCache = cachePools ?? FilePoolCache.getInstance();
      let poolData = poolCache.pools;
      if (!poolData) {
        poolData = await raydium.tradeV2.fetchRoutePoolBasicInfo();
        poolCache.setPools(poolData);
      }
      
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

class FilePoolCache implements CachePools {
  private static instance: FilePoolCache;
  private readonly filePath: string;
  private readonly cacheTime: number = 1000 * 60 * 60 * 24; // 24 hours

  private constructor() {
    this.filePath = path.join(getProjectPath(), 'pool_data.json');
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
      const data = jsonfile.readFileSync(this.filePath) as {
        time: number
        ammPools: BasicPoolInfo[]
        clmmPools: BasicPoolInfo[]
        cpmmPools: BasicPoolInfo[]
      }
      if (!this.isCacheValid(data)) {
        return null;
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
      };
    } catch {
      return null;
    }
  }

  setPools(pools: {
    ammPools: BasicPoolInfo[];
    clmmPools: BasicPoolInfo[];
    cpmmPools: BasicPoolInfo[];
  }): void {
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
  
    try {
      const dirPath = path.join(getProjectPath(), 'data');
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      jsonfile.writeFileSync(this.filePath, processedData);
    } catch (e) {
      console.error('Cache pool data failed', e);
      // Ignore write errors
    }
  }
}
