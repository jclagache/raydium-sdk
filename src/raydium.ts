import { Provider } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ApiV3PoolInfoStandardItem, PoolFetchType, Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { Commitment, Finality, Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { PriorityFee, TransactionResult } from "./types.js";
import { DEFAULT_COMMITMENT, DEFAULT_FINALITY } from "./util.js";
import { TOKEN_WSOL } from "@raydium-io/raydium-sdk-v2";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";

export class RaydiumSDK {

  public program!: Raydium;
  
  /**
   * Check if a SPL token is tradable on Raydium by verifying if pools exist.
   * @param mint The SPL token mint address to check
   * @param connection The Solana connection to use
   * @returns Promise<boolean> True if the token is tradable, false otherwise
   */
  static async isTradable(mint: PublicKey, connection: Connection): Promise<boolean> {
    try {
      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      const raydium = await Raydium.load({
        connection,
        cluster: "mainnet",
      });

      // Essayer de trouver un pool pour ce token
      const pools = await raydium.api.fetchPoolByMints({
        mint1: wsolMint,
        mint2: mint,
        sort: 'liquidity'
      });
      
      // Si on trouve au moins un pool, le token est tradable
      return pools && pools.data.length > 0;
    } catch (error) {
      console.error('Error checking if token is tradable:', error);
      return false;
    }
  }

  constructor(provider: Provider) {
    if (!provider.wallet) {
      throw new Error("Provider wallet is undefined");
    }

    Raydium.load({
      connection: provider.connection,
      owner: provider.wallet.payer,
      cluster: "mainnet",
      disableFeatureCheck: true,
      blockhashCommitment: 'finalized'
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
    try {
      // Vérifier que buyer est une keypair valide avec clé privée
      if (!buyer.secretKey || buyer.secretKey.length === 0) {
        throw new Error(`Cannot use buyer key ${buyer.publicKey.toString()} for signing - missing secret key`);
      }

      const wsolMint = new PublicKey(TOKEN_WSOL.address);

      // Chercher un pool pour cette paire
      const pools = await this.program.api.fetchPoolByMints({
        mint1: wsolMint,
        mint2: mint,
        sort: 'liquidity',
        type: PoolFetchType.Standard
      });

      if (!pools || pools.data.length === 0)
        throw new Error(`No pool found for ${mint.toBase58()}`);

      const poolInfo = pools.data[0] as ApiV3PoolInfoStandardItem;
      console.log(`[BUY] Using pool: ${poolInfo.id}`);

      const poolKeys = await this.program.liquidity.getAmmPoolKeys(poolInfo.id)
      const rpcData = await this.program.liquidity.getRpcPoolInfo(poolInfo.id)
      const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()]

      const out = this.program.liquidity.computeAmountOut({
        poolInfo: {
          ...poolInfo,
          baseReserve,
          quoteReserve,
          status,
          version: 4,
        },
        amountIn: new BN(buyAmountSol.toString()),
        mintIn: wsolMint,
        mintOut: mint,
        slippage: Number(slippageBasisPoints) / 10000, // range: 1 ~ 0.0001, means 100% ~ 0.01%
      })


      const { execute } = await this.program.liquidity.swap({
        poolInfo,
        poolKeys,
        amountIn: new BN(buyAmountSol.toString()),
        amountOut: out.minAmountOut, // out.amountOut means amount 'without' slippage
        fixedSide: 'in',
        inputMint: wsolMint.toString(),
        txVersion: TxVersion.V0,
        // optional: set up priority fee here
        // computeBudgetConfig: {
        //   units: 600000,
        //   microLamports: 46591500,
        // },
      })

      // Exécuter la transaction avec le SDK
      const { txId } = await execute({ sendAndConfirm: true })
      console.log(`swap successfully in amm pool:`, { txId: `https://explorer.solana.com/tx/${txId}` })

      return {
        success: true,
        signature: txId
      };
    } catch (error) {
      console.error(`[BUY] Error during buy:`, error);

      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          if (logs) {
            console.error(`[BUY] Transaction logs:`, logs);
          } else {
            console.error(`[BUY] No transaction logs available.`);
          }
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
      // Vérifier que seller est une keypair valide avec clé privée
      if (!seller.secretKey || seller.secretKey.length === 0) {
        throw new Error(`Cannot use seller key ${seller.publicKey.toString()} for signing - missing secret key`);
      }
      
      const wsolMint = new PublicKey(TOKEN_WSOL.address);
      
      // Chercher un pool pour cette paire
      const pools = await this.program.api.fetchPoolByMints({
        mint1: mint,
        mint2: wsolMint,
        sort: 'liquidity',
        type: PoolFetchType.Standard
      });

      if (!pools || pools.data.length === 0)
        throw new Error(`No pool found for ${mint.toBase58()}`);

      const poolInfo = pools.data[0] as ApiV3PoolInfoStandardItem;
      console.log(`[SELL] Using pool: ${poolInfo.id}`);

      const poolKeys = await this.program.liquidity.getAmmPoolKeys(poolInfo.id)
      const rpcData = await this.program.liquidity.getRpcPoolInfo(poolInfo.id)
      const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()]

      const out = this.program.liquidity.computeAmountOut({
        poolInfo: {
          ...poolInfo,
          baseReserve,
          quoteReserve,
          status,
          version: 4,
        },
        amountIn: new BN(sellAmount.toString()),
        mintIn: mint,
        mintOut: wsolMint,
        slippage: Number(slippageBasisPoints) / 10000,
      })

      const { execute } = await this.program.liquidity.swap({
        poolInfo,
        poolKeys,
        amountIn: new BN(sellAmount.toString()),
        amountOut: out.minAmountOut,
        fixedSide: 'in',
        inputMint: mint.toString(),
        txVersion: TxVersion.V0,
        // optional: set up priority fee here
        // computeBudgetConfig: {
        //   units: 600000,
        //   microLamports: 46591500,
        // },
      })

      // Exécuter la transaction avec le SDK
      const { txId } = await execute({ sendAndConfirm: true })
      console.log(`sold successfully in amm pool:`, { txId: `https://explorer.solana.com/tx/${txId}` })

      return {
        success: true,
        signature: txId
      };
    } catch (error) {
      console.error(`[SELL] Error during sell:`, error);
      
      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.program.connection).catch(() => null);
          if (logs) {
            console.error(`[SELL] Transaction logs:`, logs);
          } else {
            console.error(`[SELL] No transaction logs available.`);
          }
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
}










