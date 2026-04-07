/** Write-only ABIs — all reads now go through the server API. */

export const REGISTRY_ABI = [
  {
    name: "registerEndpoint",
    type: "function",
    inputs: [
      { name: "url",              type: "string"  },
      { name: "pricePerCall",     type: "uint256" },
      { name: "paymasterAddress", type: "address" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    name: "setRequireWorldId",
    type: "function",
    inputs: [
      { name: "endpointId", type: "uint256" },
      { name: "required", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const PAYMASTER_ABI = [
  {
    name: "fundAndSetGasShare",
    type: "function",
    inputs: [
      { name: "url", type: "string" },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    name: "setGasShare",
    type: "function",
    inputs: [
      { name: "url", type: "string" },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
