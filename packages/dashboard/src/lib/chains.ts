export const NETWORKS = {
  baseSepolia: {
    id: "baseSepolia" as const,
    label: "Base Sepolia",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    currency: "ETH",
    explorerBase: "https://sepolia.basescan.org",
    explorerTx: (h: string) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddr: (a: string) => `https://sepolia.basescan.org/address/${a}`,
    color: "#2151f5",
    tag: "BASE",
  },
} as const;

export type NetworkId = keyof typeof NETWORKS;

export const DEPLOYMENTS = {
  baseSepolia: {
    publisherRegistry: "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2" as `0x${string}`,
    paymaster: "0xddf2721Fd097Ed8e7998858C492a62d9D378626f" as `0x${string}`,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
    deployer: "0x05a7Ae061c14847e0B70f7851d76FC10289d69b0" as `0x${string}`,
    deployedAt: "2026-04-03T21:46:49.761Z",
    txHashes: {
      registry: "0x9c1653279c010f3b5b4b1dec4438d60d7deea56d00dc0512cb3d8dfc6f3c4dc4",
      paymaster: "0x6d6e17e9a9ad1a8ab781928168737ad8a00aa9d68079c65972312ea710f3269e",
      register: "0x9fa5eb68c10d3448ac73b47313550f8ab9bbc468e1fdb29933537cf4041cd072",
      fund: "0x623b89b9a2fe91228f0b978b288e81e24f7da10c6bb222352a3f90265e659df4",
    },
  },
} as const;
