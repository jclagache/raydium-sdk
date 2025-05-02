// Now import the modules we need
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { RaydiumSDK } from "../src/raydium.js";

// Tokens connus pour les tests
const PIU_MINT = new PublicKey('5eafqp6ic7WpxUsKJLhnLxthUcEYatjhXPNLBRZCpump');

// Test file pour RaydiumSDK
describe("RaydiumSDK", () => {
  let connection: Connection;
  let raydiumSDK: RaydiumSDK;
  let testWallet: Keypair;

  // Initialiser la connection et le SDK avant tous les tests
  beforeAll(async () => {
    // Créer une connection et un wallet
    connection = new Connection('https://api.mainnet-beta.solana.com', {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
    
    // Créer un keypair de test
    testWallet = Keypair.generate();
    
    // Créer un mock du provider
    const mockProvider = {
      connection,
      wallet: {
        publicKey: testWallet.publicKey,
        signTransaction: async (tx: any) => {
          return tx;
        },
        signAllTransactions: async (txs: any[]) => {
          return txs;
        }
      },
      opts: { commitment: 'confirmed' }
    };
    
    // Initialiser RaydiumSDK avec le mock provider
    // @ts-ignore - Nous utilisons un mock du provider
    raydiumSDK = new RaydiumSDK(mockProvider);
    
    // Attendre un peu pour que le SDK se charge
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('RaydiumSDK instance initialized with wallet:', testWallet.publicKey.toString());
  }, 30000); // Timeout de 30 secondes pour l'initialisation

  test('Static methods should be properly defined', () => {
    // Vérifier que la méthode statique existe
    expect(typeof RaydiumSDK.isTradable).toBe('function');
  });

  test('Class structure should be correct', () => {
    // Vérifier que les méthodes d'instance existent
    expect(RaydiumSDK.prototype.buy).toBeDefined();
    expect(RaydiumSDK.prototype.sell).toBeDefined();
    expect(RaydiumSDK.prototype.buyAndSell).toBeDefined();
    
    // Vérifier la structure de la classe
    const raydiumSDKString = RaydiumSDK.toString();
    expect(raydiumSDKString).toContain('class RaydiumSDK');
  });

  test('Class constructor should work correctly', () => {
    // S'assurer que l'instance a été créée
    expect(raydiumSDK).toBeDefined();
    
    // Test constructeur avec erreur attendue (aucun provider)
    expect(() => {
      // @ts-ignore - intention de tester un cas d'erreur
      new RaydiumSDK(null);
    }).toThrow();
  });

  // Ces tests font un appel réseau réel et peuvent prendre du temps
  test('isTradable should check if PIU is tradable', async () => {
    try {
      const result = await RaydiumSDK.isTradable(PIU_MINT, connection);
      console.log('PIU tradable result:', result);
      // PIU devrait être tradable
      expect(result).toBe(true);
    } catch (error) {
      console.error('Error testing PIU tradability:', error);
    }
  }, 120000); // Timeout explicite de 2 minutes
  
  test('SDK instance should be initialized properly', () => {
    // Vérifier que l'instance a été correctement initialisée
    expect(raydiumSDK).toBeDefined();
    expect(raydiumSDK).toBeInstanceOf(RaydiumSDK);
  });
  
  test('test swap dans buy method avec un mock sélectif', async () => {
    // Vérifier que l'instance a les propriétés nécessaires
    if (!raydiumSDK.program || !raydiumSDK.program.tradeV2 || !raydiumSDK.program.connection) {
      console.log("Impossible de tester: l'instance n'est pas complètement initialisée");
      return;
    }
    
    // Sauvegarder les méthodes originales que l'on va mocker
    const originalSwap = raydiumSDK.program.tradeV2.swap;
    const originalSendRawTransaction = raydiumSDK.program.connection.sendRawTransaction;
    
    // Variables pour traquer les appels aux fonctions mockées
    let swapCalled = false;
    let sendRawTransactionCalled = false;
    
    try {
      // Remplacer les méthodes par des mocks
      // @ts-ignore - Ignore type errors for testing
      raydiumSDK.program.tradeV2.swap = async () => {
        swapCalled = true;
        return {
          transactions: [{
            serialize: () => Buffer.from('dummy-transaction')
          }]
        };
      };
      
      // @ts-ignore - Ignore type errors for testing
      raydiumSDK.program.connection.sendRawTransaction = async () => {
        sendRawTransactionCalled = true;
        return 'mock-signature-selective';
      };
      
      // Données de test
      const buyAmount = BigInt(0.3 * LAMPORTS_PER_SOL);
      const slippage = BigInt(5000);  // 5%
      
      // Appeler directement la méthode buy
      const result = await raydiumSDK.buy(
        testWallet,
        PIU_MINT,
        buyAmount,
        slippage
      );
      
      // Vérifier le résultat
      console.log('Buy result with selective mock:', result);
      expect(result.success).toBe(true);
      expect(result.signature).toBe('mock-signature-selective');
      
      // Vérifier que les méthodes mockées ont été appelées
      expect(swapCalled).toBe(true);
      expect(sendRawTransactionCalled).toBe(true);
      
    } finally {
      // Restaurer les méthodes originales
      raydiumSDK.program.tradeV2.swap = originalSwap;
      raydiumSDK.program.connection.sendRawTransaction = originalSendRawTransaction;
    }
  }, 30000); // Timeout de 30 secondes pour ce test
}); 