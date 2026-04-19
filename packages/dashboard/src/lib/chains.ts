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
    publisherRegistry: "0xD1Dc9293031DB577F8f39817C35deA9Fc8024456" as `0x${string}`,
    paymentSplitter: "0x91Db1389A1cab57A01C146d43d11c205f779ED4d" as `0x${string}`,
    reviewRegistry: "0x2227db7383EE302880AD2a50745b8c61DDD14cB6" as `0x${string}`,
    paymaster: "0xddf2721Fd097Ed8e7998858C492a62d9D378626f" as `0x${string}`,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
    deployer: "0x05a7Ae061c14847e0B70f7851d76FC10289d69b0" as `0x${string}`,
    deployedAt: "2026-04-19T18:55:28.535Z",
    txHashes: {
      registry: "0x96562a76f73febc97aaf7b7a1dd8560d207acdedea8626a6adb0a79b1c021002",
      paymentSplitter: "0x815d654156f246af3cfa25837a74fa4bfe446d497c695aa6ddeb3d84893e8958",
      reviewRegistry: "0xea3d90690ba64d39a9e8f62b959c69f33d2cb1621a5a95d491d9c18ed3a97cad",
    },
  },
} as const;
