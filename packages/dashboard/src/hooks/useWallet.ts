import { useState, useCallback } from "react";
import { createWalletClient, custom, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { NETWORKS } from "../lib/chains";
import type { NetworkId } from "../lib/chains";

export interface WalletState {
  address: `0x${string}` | null;
  chainId: number | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
}

declare global {
  interface Window {
    ethereum?: any;
  }
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    chainId: null,
    connected: false,
    connecting: false,
    error: null,
  });

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState((s) => ({ ...s, error: "No wallet detected (install Rabby or MetaMask)" }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
      setState({
        address: address as `0x${string}`,
        chainId: parseInt(chainIdHex, 16),
        connected: true,
        connecting: false,
        error: null,
      });
    } catch (e: any) {
      setState((s) => ({ ...s, connecting: false, error: e.message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ address: null, chainId: null, connected: false, connecting: false, error: null });
  }, []);

  const switchNetwork = useCallback(async (networkId: NetworkId) => {
    if (!window.ethereum) return;
    const net = NETWORKS[networkId];
    const chainHex = "0x" + net.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      setState((s) => ({ ...s, chainId: net.chainId }));
    } catch (e: any) {
      // Chain not added — add it
      if (e.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: chainHex,
              chainName: net.label,
              nativeCurrency: { name: net.currency, symbol: net.currency, decimals: 18 },
              rpcUrls: [net.rpc],
              blockExplorerUrls: [net.explorerBase],
            }],
          });
          setState((s) => ({ ...s, chainId: net.chainId }));
        } catch (addErr: any) {
          setState((s) => ({ ...s, error: addErr.message }));
        }
      } else {
        setState((s) => ({ ...s, error: e.message }));
      }
    }
  }, []);

  /** Write a contract function. Returns tx hash. value = optional ETH to send (payable). */
  const writeContract = useCallback(
    async (
      networkId: NetworkId,
      contractAddr: `0x${string}`,
      abi: any[],
      functionName: string,
      args: any[],
      value?: bigint
    ) => {
      if (!window.ethereum || !state.address) throw new Error("Wallet not connected");

      const chain = baseSepolia;
      const walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
      const publicClient = createPublicClient({ chain, transport: http(NETWORKS[networkId].rpc) });

      const { request } = await publicClient.simulateContract({
        address: contractAddr,
        abi,
        functionName,
        args,
        account: state.address,
        ...(value !== undefined ? { value } : {}),
      });
      const hash = await walletClient.writeContract({ ...request });
      return hash;
    },
    [state.address]
  );

  return { state, connect, disconnect, switchNetwork, writeContract };
}
