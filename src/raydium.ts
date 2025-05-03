import { Provider } from "@coral-xyz/anchor";
import { BasicPoolInfo, JupTokenType, Raydium, TxVersion, Token, toApiV3Token, ReturnTypeGetAllRoute, ReturnTypeFetchMultipleMintInfos, AmmRpcData, ComputeAmountOutParam, ClmmRpcData, ReturnTypeFetchMultiplePoolTickArrays, ComputeClmmPoolInfo, ComputeRoutePathType, CpmmComputeData, Router } from "@raydium-io/raydium-sdk-v2";
import { Commitment, Finality, Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "./types.js";
import { DEFAULT_COMMITMENT, DEFAULT_FINALITY } from "./util.js";
import { TOKEN_WSOL } from "@raydium-io/raydium-sdk-v2";
import { TokenAmount } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddress, getAccount, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { InMemoryRouteCache, FilePoolCache, CacheRoutesData, InMemoryRouteDataCache, CacheRoutes, CachePools } from "./cache.js";


export class RaydiumSDK {
  public program!: Raydium;
  private cachePools: CachePools | null = null;
  private cacheRoutes: CacheRoutes = InMemoryRouteCache.getInstance();
  private cacheRoutesData: CacheRoutesData = InMemoryRouteDataCache.getInstance();
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

  async fetchSwapRoutesData(inputMint: string | PublicKey, outputMint: string | PublicKey, routes?: ReturnTypeGetAllRoute): Promise<{
    mintInfos: ReturnTypeFetchMultipleMintInfos;
    ammPoolsRpcInfo: Record<string, AmmRpcData>;
    ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
    clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
    computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
    computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
    computeCpmmData: Record<string, CpmmComputeData>;
    routePathDict: ComputeRoutePathType;
  }> {
    const inputMintStr = typeof inputMint === 'string' ? inputMint : inputMint.toBase58();
    const outputMintStr = typeof outputMint === 'string' ? outputMint : outputMint.toBase58();

    // Check the route data cache
    const cachedRouteData = this.cacheRoutesData.getRoutesData(
      inputMint instanceof PublicKey ? inputMint : new PublicKey(inputMint),
      outputMint instanceof PublicKey ? outputMint : new PublicKey(outputMint)
    );

    if (cachedRouteData) {
      return cachedRouteData;
    }

    // If routes is not provided, get routes first
    if (!routes) {
      const inputMintPK = inputMint instanceof PublicKey ? inputMint : new PublicKey(inputMint);
      const outputMintPK = outputMint instanceof PublicKey ? outputMint : new PublicKey(outputMint);
      
      routes = this.getAllRoute(inputMintPK, outputMintPK);
      if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
        return Promise.resolve({
          mintInfos: {},
          ammPoolsRpcInfo: {},
          ammSimulateCache: {},
          clmmPoolsRpcInfo: {},
          computeClmmPoolInfo: {},
          computePoolTickData: {},
          computeCpmmData: {},
          routePathDict: {}
        });
      }
    }

    const routesData = await this.program.tradeV2.fetchSwapRoutesData({
      routes,
      inputMint,
      outputMint
    });
    
    // Cache the obtained data
    this.cacheRoutesData.setRoutesData(
      routesData,
      inputMint,
      outputMint
    );
    return routesData;
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
    try {
      await this.program.fetchChainTime();

      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      const inputMint = wsolMint;
      const outputMint = mint;

      const inputMintStr = inputMint.toBase58();
      const outputMintStr = outputMint.toBase58();

      let routes = this.getAllRoute(inputMint, outputMint);
      if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
        const poolCache = this.cachePools ?? FilePoolCache.getInstance();
        let poolData = poolCache.pools;

        if (!poolData) {
          console.log('fetching all pool basic info, this might take a while (more than 1 minutes)..')
          poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo();
          if (poolData) {
            poolCache.setPools(poolData);
          } else {
            throw new Error("Failed to fetch pool data");
          }
        }

        if (poolData.ammPools.length === 0 && poolData.clmmPools.length === 0 && poolData.cpmmPools.length === 0) {
          throw new Error("ammPools, clmmPools and cpmmPools are empty");
        }

        routes = this.getAllRoute(inputMint, outputMint, poolData.clmmPools, poolData.ammPools, poolData.cpmmPools);

        if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
          throw new Error(`No swap route found between ${inputMintStr} and ${outputMintStr}`);
        }
      }

      let routesData = await this.fetchSwapRoutesData(inputMint, outputMint, routes);
      
      if (Object.keys(routesData.mintInfos).length === 0) {
        routesData = await this.program.tradeV2.fetchSwapRoutesData({
          routes,
          inputMint,
          outputMint
        });
      }

      if (!routesData.mintInfos[inputMintStr] || !routesData.mintInfos[outputMintStr]) {
        throw new Error(`Missing mint info for ${!routesData.mintInfos[inputMintStr] ? inputMintStr : outputMintStr}`);
      }

      const inputAmount = buyAmountSol.toString();

      const inputTokenAmount = new TokenAmount(
        new Token({
          mint: inputMintStr,
          decimals: routesData.mintInfos[inputMintStr].decimals,
          isToken2022: routesData.mintInfos[inputMintStr].programId.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
        }),
        inputAmount
      );

      const slippage = Number(slippageBasisPoints) / 10000;
      const epochInfo = await this.program.connection.getEpochInfo();

      const outputTokenApi = toApiV3Token({
        address: outputMintStr,
        programId: routesData.mintInfos[outputMintStr].programId.toBase58(),
        decimals: routesData.mintInfos[outputMintStr].decimals,
        name: outputMintStr.slice(0, 5),
        symbol: outputMintStr.slice(0, 5),
        logoURI: '',
        chainId: 0
      });

      const swapRoutes = this.program.tradeV2.getAllRouteComputeAmountOut({
        inputTokenAmount,
        directPath: routes.directPath.map(
          (p) => routesData.ammSimulateCache[p.id.toBase58()] ||
            routesData.computePoolTickData[p.id.toBase58()] ||
            routesData.computeCpmmData[p.id.toBase58()]
        ),
        routePathDict: routesData.routePathDict,
        simulateCache: routesData.ammSimulateCache,
        tickCache: routesData.computePoolTickData,
        outputToken: outputTokenApi,
        mintInfos: routesData.mintInfos,
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
        ammRpcData: routesData.ammPoolsRpcInfo,
        clmmRpcData: routesData.clmmPoolsRpcInfo
      });

      const { execute, transactions } = await this.program.tradeV2.swap({
        routeProgram: Router,
        txVersion: TxVersion.V0,
        swapInfo: targetRoute,
        swapPoolKeys: poolKeys,
        ownerInfo: {
          associatedOnly: true,
          checkCreateATAOwner: true,
        },
        computeBudgetConfig: {
          units: 600000,
          microLamports: 465915,
        }
      });
      const { txIds } = await execute({ sequentially: true })
      txIds.forEach((txId) => console.log(`https://explorer.solana.com/tx/${txId}`))
      return {
        success: true,
        signature: txIds[0]
      };
    } catch (error) {
      console.error(`[BUY] Error during buy:`, error);
      if (error instanceof SendTransactionError) {
        try {
          // Try to get logs but handle potential errors as these properties might be private
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          console.error(`[BUY] Transaction error details:`, error.message);
          
          if (logs) {
            console.error(`[BUY] Transaction logs:`, logs);
          } else {
            console.error(`[BUY] No transaction logs available. Simulation may have failed.`);
          }
          
          // Print the full error as JSON for debugging
          console.error(`[BUY] Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch (logError) {
          console.error(`[BUY] Failed to get transaction logs:`, logError);
        }
      }
      throw error;
    }
  }

  /**
   * Sell a SPL token for SOL via Raydium swap.
   */
  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellAmount: bigint,
    slippageBasisPoints = BigInt(500),
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    try {
      await this.program.fetchChainTime();

      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      const inputMint = mint;
      const outputMint = wsolMint;

      const inputMintStr = inputMint.toBase58();
      const outputMintStr = outputMint.toBase58();

      let routes = this.getAllRoute(inputMint, outputMint);
      if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
        const poolCache = this.cachePools ?? FilePoolCache.getInstance();
        let poolData = poolCache.pools;

        if (!poolData) {
          poolData = await this.program.tradeV2.fetchRoutePoolBasicInfo();
          if (poolData) {
            poolCache.setPools(poolData);
          } else {
            throw new Error("Failed to fetch pool data");
          }
        }

        if (!poolData) {
          throw new Error("Pool data is null");
        }

        routes = this.getAllRoute(inputMint, outputMint, poolData.clmmPools, poolData.ammPools, poolData.cpmmPools);

        if (Object.keys(routes.directPath).length === 0 && Object.keys(routes.routePathDict).length === 0) {
          throw new Error(`No swap route found between ${inputMintStr} and ${outputMintStr}`);
        }
      }

      let routesData = await this.fetchSwapRoutesData(inputMint, outputMint, routes);

      if (Object.keys(routesData.mintInfos).length === 0) {
        routesData = await this.program.tradeV2.fetchSwapRoutesData({
          routes,
          inputMint,
          outputMint
        });
      }

      if (!routesData.mintInfos[inputMintStr] || !routesData.mintInfos[outputMintStr]) {
        throw new Error(`Missing mint info for ${!routesData.mintInfos[inputMintStr] ? inputMintStr : outputMintStr}`);
      }

      const tokenAccount = getAssociatedTokenAddressSync(
        mint,
        seller.publicKey,
        false,
        routesData.mintInfos[inputMintStr].programId
      );

      const accountInfo = await this.program.connection.getAccountInfo(tokenAccount);
      if (!accountInfo) {
        throw new Error(`Token account ${tokenAccount.toBase58()} not found`);
      }

      const parsedTokenAccount = unpackAccount(tokenAccount, accountInfo);
      if (parsedTokenAccount.amount < sellAmount) {
        throw new Error(`Insufficient token balance. Have ${parsedTokenAccount.amount}, need ${sellAmount}`);
      }

      const inputAmount = sellAmount.toString();

      const inputTokenAmount = new TokenAmount(
        new Token({
          mint: inputMintStr,
          decimals: routesData.mintInfos[inputMintStr].decimals,
          isToken2022: routesData.mintInfos[inputMintStr].programId.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
        }),
        inputAmount
      );

      const slippage = Number(slippageBasisPoints) / 10000;
      const epochInfo = await this.program.connection.getEpochInfo();

      const outputTokenApi = toApiV3Token({
        address: outputMintStr,
        programId: routesData.mintInfos[outputMintStr].programId.toBase58(),
        decimals: routesData.mintInfos[outputMintStr].decimals,
        name: outputMintStr.slice(0, 5),
        symbol: outputMintStr.slice(0, 5),
        logoURI: '',
        chainId: 0
      });

      const swapRoutes = this.program.tradeV2.getAllRouteComputeAmountOut({
        inputTokenAmount,
        directPath: routes.directPath.map(
          (p) => routesData.ammSimulateCache[p.id.toBase58()] ||
            routesData.computePoolTickData[p.id.toBase58()] ||
            routesData.computeCpmmData[p.id.toBase58()]
        ),
        routePathDict: routesData.routePathDict,
        simulateCache: routesData.ammSimulateCache,
        tickCache: routesData.computePoolTickData,
        outputToken: outputTokenApi,
        mintInfos: routesData.mintInfos,
        slippage,
        chainTime: Math.floor(this.program.chainTimeData?.chainTime ?? Date.now() / 1000),
        epochInfo
      });

      if (!swapRoutes.length) {
        if (sellAmount < BigInt(10000)) {
          console.error(`[SELL] No swap routes found - Try with a larger amount`);
          throw new Error("No swap route found - Amount too small");
        }
        throw new Error("No swap route found");
      }

      const targetRoute = swapRoutes[0];

      const poolKeys = await this.program.tradeV2.computePoolToPoolKeys({
        pools: targetRoute.poolInfoList,
        ammRpcData: routesData.ammPoolsRpcInfo,
        clmmRpcData: routesData.clmmPoolsRpcInfo
      });

      const { execute, transactions } = await this.program.tradeV2.swap({
        routeProgram: Router,
        txVersion: TxVersion.V0,
        swapInfo: targetRoute,
        swapPoolKeys: poolKeys,
        ownerInfo: {
          associatedOnly: true,
          checkCreateATAOwner: true,
        },
        computeBudgetConfig: {
          units: 600000,
          microLamports: 465915,
        }
      });

      const { txIds } = await execute({ sequentially: true })
      txIds.forEach((txId) => console.log(`https://explorer.solana.com/tx/${txId}`))
      return {
        success: true,
        signature: txIds[0]
      };
    } catch (error) {
      console.error(`[SELL] Error during sell:`, error);
      if (error instanceof SendTransactionError) {
        try {
          // Try to get logs but handle potential errors as these properties might be private
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          console.error(`[SELL] Transaction error details:`, error.message);
          
          if (logs) {
            console.error(`[SELL] Transaction logs:`, logs);
          } else {
            console.error(`[SELL] No transaction logs available. Simulation may have failed.`);
          }
          
          // Print the full error as JSON for debugging
          console.error(`[SELL] Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch (logError) {
          console.error(`[SELL] Failed to get transaction logs:`, logError);
        }
      }
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
    let buyResult: TransactionResult;
    let sellResult: TransactionResult;

    try {
      buyResult = await this.buy(
        buyerSeller,
        mint,
        buyAmountSol,
        slippageBasisPoints,
        priorityFees,
        commitment,
        finality
      );
    } catch (error) {
      console.error(`[BUY AND SELL] Error during buy:`, error);
      if (error instanceof SendTransactionError) {
        try {
          // Try to get logs but handle potential errors as these properties might be private
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          console.error(`[BUY AND SELL] Transaction error details:`, error.message);
          
          if (logs) {
            console.error(`[BUY AND SELL] Transaction logs:`, logs);
          } else {
            console.error(`[BUY AND SELL] No transaction logs available. Simulation may have failed.`);
          }
          
          // Print the full error as JSON for debugging
          console.error(`[BUY AND SELL] Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch (logError) {
          console.error(`[BUY AND SELL] Failed to get transaction logs:`, logError);
        }
      }
      throw error;
    }

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

    try {
      sellResult = await this.sell(
        buyerSeller,
        mint,
        amountToSell,
        slippageBasisPoints,
        priorityFees,
        commitment,
        finality
      );
    } catch (error) {
      console.error(`[BUY AND SELL] Error during sell:`, error);
      if (error instanceof SendTransactionError) {
        try {
          // Try to get logs but handle potential errors as these properties might be private
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          console.error(`[BUY AND SELL] Transaction error details:`, error.message);
          
          if (logs) {
            console.error(`[BUY AND SELL] Transaction logs:`, logs);
          } else {
            console.error(`[BUY AND SELL] No transaction logs available. Simulation may have failed.`);
          }
          
          // Print the full error as JSON for debugging
          console.error(`[BUY AND SELL] Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch (logError) {
          console.error(`[BUY AND SELL] Failed to get transaction logs:`, logError);
        }
      }
      throw error;
    }

    return {
      success: sellResult.success && buyResult.success,
      signature: sellResult.signature,
    };
  }

  getAllRoute(
    inputMint: PublicKey,
    outputMint: PublicKey,
    clmmPools?: BasicPoolInfo[],
    ammPools?: BasicPoolInfo[],
    cpmmPools?: BasicPoolInfo[],
  ): ReturnTypeGetAllRoute {
    const inputMintStr = inputMint.toBase58();
    const outputMintStr = outputMint.toBase58();

    console.log(`[getAllRoute] Checking cached routes for ${inputMintStr} → ${outputMintStr}`);

    const cachedRoutes = this.cacheRoutes.getRoutes(inputMint, outputMint);
    if (cachedRoutes) {
      console.log(`[getAllRoute] Cache hit! Found routes in cache for ${inputMintStr} → ${outputMintStr}`);
      return cachedRoutes;
    }

    // Si les pools ne sont pas fournis, on ne peut pas calculer de routes
    if (!clmmPools || !ammPools || !cpmmPools) {
      console.log(`[getAllRoute] No pools provided, returning empty routes`);
      // Créer une structure ReturnTypeGetAllRoute vide valide sans appeler le SDK
      return {
        directPath: [],
        routePathDict: {},
        addLiquidityPools: [],
        needSimulate: [],
        needTickArray: [],
        cpmmPoolList: []
      } as ReturnTypeGetAllRoute;
    }

    console.log(`[getAllRoute] Cache miss. Fetching routes from chain for ${inputMintStr} → ${outputMintStr}`);
    console.log(`[getAllRoute] Pools count - AMM: ${ammPools.length}, CLMM: ${clmmPools.length}, CPMM: ${cpmmPools.length}`);

    const routes = this.program.tradeV2.getAllRoute({
      inputMint,
      outputMint,
      clmmPools,
      ammPools,
      cpmmPools,
    });

    console.log(`[getAllRoute] Routes found - Direct: ${routes.directPath.length}, Indirect: ${Object.keys(routes.routePathDict).length}`);

    // Examiner la structure des routes directes trouvées
    if (routes.directPath.length > 0) {
      const firstRoute = routes.directPath[0];
      console.log(`[getAllRoute] First direct route details - ID: ${firstRoute.id.toBase58()}, Type: ${firstRoute.version}`);
      console.log(`[getAllRoute] First direct route mints - MintA: ${firstRoute.mintA.toBase58()}, MintB: ${firstRoute.mintB.toBase58()}`);
    }

    this.cacheRoutes.setRoutes(routes, inputMint, outputMint);
    console.log(`[getAllRoute] Routes saved to cache for ${inputMintStr} → ${outputMintStr}`);

    return routes;
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

      const pools = await raydium.api.fetchPoolByMints({
        mint1: wsolMint,
        mint2: mint
      })
      return pools.data.length > 0;

    } catch (error) {
      console.error('Error checking if token is tradable:', error);
      return false;
    }
  }
}










