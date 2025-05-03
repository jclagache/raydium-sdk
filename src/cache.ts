import { AmmRpcData, BasicPoolInfo, ClmmRpcData, ComputeAmountOutParam, ComputeClmmPoolInfo, ComputeRoutePathType, CpmmComputeData, ReturnTypeFetchMultipleMintInfos, ReturnTypeFetchMultiplePoolTickArrays, ReturnTypeGetAllRoute } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import path from "path";
import fs from "fs";
import jsonfile from "jsonfile";
import { getProjectPath } from "./util.js";

export interface CacheRoutesData {
    setRoutesData: (routesData: {
      mintInfos: ReturnTypeFetchMultipleMintInfos;
      ammPoolsRpcInfo: Record<string, AmmRpcData>;
      ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
      clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
      computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
      computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
      computeCpmmData: Record<string, CpmmComputeData>;
      routePathDict: ComputeRoutePathType;
    }, inputMint: string | PublicKey, outputMint: string | PublicKey) => void;
    getRoutesData: (inputMint: PublicKey, outputMint: PublicKey) => {
      mintInfos: ReturnTypeFetchMultipleMintInfos;
      ammPoolsRpcInfo: Record<string, AmmRpcData>;
      ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
      clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
      computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
      computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
      computeCpmmData: Record<string, CpmmComputeData>;
      routePathDict: ComputeRoutePathType;
    } | null;
}

export class InMemoryRouteDataCache implements CacheRoutesData {
    private static instance: InMemoryRouteDataCache;
    private readonly cacheTime: number = 1000 * 60 * 60 * 4; // 4 hours
    private routesDataCache: Record<string, {
        time: number;
        data: {
            mintInfos: ReturnTypeFetchMultipleMintInfos;
            ammPoolsRpcInfo: Record<string, AmmRpcData>;
            ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
            clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
            computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
            computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
            computeCpmmData: Record<string, CpmmComputeData>;
            routePathDict: ComputeRoutePathType;
        }
    }> = {};

    private constructor() {}

    private isCacheValid(data: { time: number }): boolean {
        return Date.now() - data.time <= this.cacheTime;
    }

    private getCacheKey(inputMint: PublicKey | string, outputMint: PublicKey | string): string {
        const inputStr = typeof inputMint === 'string' ? inputMint : inputMint.toBase58();
        const outputStr = typeof outputMint === 'string' ? outputMint : outputMint.toBase58();
        return `${inputStr}_${outputStr}`;
    }

    static getInstance(): InMemoryRouteDataCache {
        if (!InMemoryRouteDataCache.instance) {
            InMemoryRouteDataCache.instance = new InMemoryRouteDataCache();
        }
        return InMemoryRouteDataCache.instance;
    }

    getRoutesData(inputMint: PublicKey, outputMint: PublicKey): {
        mintInfos: ReturnTypeFetchMultipleMintInfos;
        ammPoolsRpcInfo: Record<string, AmmRpcData>;
        ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
        clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
        computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
        computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
        computeCpmmData: Record<string, CpmmComputeData>;
        routePathDict: ComputeRoutePathType;
    } | null {
        const cacheKey = this.getCacheKey(inputMint, outputMint);
        const cachedData = this.routesDataCache[cacheKey];

        if (!cachedData) {
            return null;
        }

        if (this.isCacheValid(cachedData)) {
            return cachedData.data;
        }

        return null;
    }

    setRoutesData(routesData: {
        mintInfos: ReturnTypeFetchMultipleMintInfos;
        ammPoolsRpcInfo: Record<string, AmmRpcData>;
        ammSimulateCache: Record<string, ComputeAmountOutParam["poolInfo"]>;
        clmmPoolsRpcInfo: Record<string, ClmmRpcData>;
        computeClmmPoolInfo: Record<string, ComputeClmmPoolInfo>;
        computePoolTickData: ReturnTypeFetchMultiplePoolTickArrays;
        computeCpmmData: Record<string, CpmmComputeData>;
        routePathDict: ComputeRoutePathType;
    }, inputMint: string | PublicKey, outputMint: string | PublicKey): void {
        const cacheKey = this.getCacheKey(inputMint, outputMint);

        this.routesDataCache[cacheKey] = {
            time: Date.now(),
            data: routesData
        };
    }
}

export interface CacheRoutes {
    setRoutes: (routes: ReturnTypeGetAllRoute, inputMint: PublicKey, outputMint: PublicKey) => void;
    getRoutes: (inputMint: PublicKey, outputMint: PublicKey) => ReturnTypeGetAllRoute | null;
}

export class InMemoryRouteCache implements CacheRoutes {
    private static instance: InMemoryRouteCache;
    private readonly cacheTime: number = 1000 * 60 * 60 * 4; // 4 hours
    private routesCache: Record<string, {
        time: number;
        routes: ReturnTypeGetAllRoute;
    }> = {};

    private constructor() {}

    private isCacheValid(data: { time: number }): boolean {
        return Date.now() - data.time <= this.cacheTime;
    }

    private getCacheKey(inputMint: PublicKey, outputMint: PublicKey): string {
        return `${inputMint.toBase58()}_${outputMint.toBase58()}`;
    }

    static getInstance(): InMemoryRouteCache {
        if (!InMemoryRouteCache.instance) {
            InMemoryRouteCache.instance = new InMemoryRouteCache();
        }
        return InMemoryRouteCache.instance;
    }

    getRoutes(inputMint: PublicKey, outputMint: PublicKey): ReturnTypeGetAllRoute | null {
        const cacheKey = this.getCacheKey(inputMint, outputMint);
        const cachedData = this.routesCache[cacheKey];

        if (!cachedData) {
            return null;
        }

        if (this.isCacheValid(cachedData)) {
            return cachedData.routes;
        }

        return null;
    }

    setRoutes(routes: ReturnTypeGetAllRoute, inputMint: PublicKey, outputMint: PublicKey): void {
        const cacheKey = this.getCacheKey(inputMint, outputMint);

        this.routesCache[cacheKey] = {
            time: Date.now(),
            routes
        };
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

export class FilePoolCache implements CachePools {
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


