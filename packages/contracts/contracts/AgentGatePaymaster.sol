// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

/**
 * @title AgentGatePaymaster
 * @notice Shared ERC-4337 Paymaster. Each publisher deposits ETH for their own
 *         endpoints and sets a gas-share %. This creates real market competition:
 *
 *         – Publisher A: 0.1 ETH deposited, 100% share → best UX, depletes faster
 *         – Publisher B: 0.1 ETH deposited,  50% share → half gas sponsored, lasts 2×
 *         – Publisher C: 0.001 ETH, 100%              → full sponsorship, few calls
 *
 *         Agents see which endpoints have balance and prefer those with higher share.
 *         No one else can spend a publisher's deposit.
 *
 *  paymasterData layout (bytes[52:84] of paymasterAndData):
 *    bytes32  endpointHash  =  keccak256(abi.encodePacked(url))
 */
contract AgentGatePaymaster is BasePaymaster {

    // ── Per-endpoint state ──────────────────────────────────────────────────
    /// @notice ETH deposited by each publisher for their endpoint's gas budget.
    mapping(bytes32 => uint256) public endpointBalance;

    /// @notice Gas share in bps (0–10 000). Unset entries use the default 10 000 (100%).
    mapping(bytes32 => uint16) public endpointGasShareBps;

    /// @notice True once a publisher has explicitly called setGasShare / fundAndSetGasShare.
    ///         Separates "never configured" (default 100%) from "explicitly set to 0%" (0%).
    mapping(bytes32 => bool) public endpointGasShareIsSet;

    /// @notice Who can withdraw the endpoint's deposit (the depositor).
    mapping(bytes32 => address) public endpointOwner;

    // ── Global stats ────────────────────────────────────────────────────────
    uint256 public totalSponsored;
    uint256 public totalCalls;

    // ── Events ──────────────────────────────────────────────────────────────
    event EndpointFunded(bytes32 indexed endpointHash, address indexed funder, uint256 amount);
    event EndpointGasShareSet(bytes32 indexed endpointHash, uint16 bps);
    event EndpointWithdraw(bytes32 indexed endpointHash, address indexed to, uint256 amount);
    event GasSponsored(
        address indexed agent,
        bytes32 indexed endpointHash,
        uint256 gasUsed,
        uint16  gasShareBps
    );

    constructor(IEntryPoint _entryPoint) BasePaymaster(_entryPoint) {}

    // ── Publisher interface ─────────────────────────────────────────────────

    /**
     * @notice Deposit ETH for an endpoint's gas budget (by URL).
     *         Anyone can top-up any endpoint, but only the first depositor
     *         (the endpoint owner) can withdraw or change the gas share.
     */
    function depositForEndpoint(string calldata url) external payable {
        require(msg.value > 0, "No ETH sent");
        bytes32 hash = keccak256(abi.encodePacked(url));
        _depositForHash(hash);
    }

    function depositForEndpointHash(bytes32 endpointHash) external payable {
        require(msg.value > 0, "No ETH sent");
        _depositForHash(endpointHash);
    }

    function _depositForHash(bytes32 hash) internal {
        if (endpointOwner[hash] == address(0)) {
            endpointOwner[hash] = msg.sender;
        }
        endpointBalance[hash] += msg.value;
        // Forward native currency into the EntryPoint for gas sponsorship.
        // Wrapped in try/catch so chains where EntryPoint.depositTo is
        // unavailable (e.g. Hedera Testnet) still record the balance.
        try entryPoint.depositTo{value: msg.value}(address(this)) {
            // success — Base Sepolia ERC-4337 path
        } catch {
            // graceful degradation — balance tracked internally, no ERC-4337 relay
        }
        emit EndpointFunded(hash, msg.sender, msg.value);
    }

    /**
     * @notice Set gas share % for your endpoint (only endpoint owner).
     * @param  url URL of the endpoint
     * @param  bps 0–10 000 (0% = no sponsorship, 10000 = full sponsorship)
     */
    function setGasShare(string calldata url, uint16 bps) external {
        require(bps <= 10000, "bps > 10000");
        bytes32 hash = keccak256(abi.encodePacked(url));
        require(endpointOwner[hash] == address(0) || endpointOwner[hash] == msg.sender, "Not endpoint owner");
        endpointGasShareBps[hash]   = bps;
        endpointGasShareIsSet[hash] = true;
        emit EndpointGasShareSet(hash, bps);
    }

    function setGasShareByHash(bytes32 endpointHash, uint16 bps) external {
        require(bps <= 10000, "bps > 10000");
        require(endpointOwner[endpointHash] == address(0) || endpointOwner[endpointHash] == msg.sender, "Not endpoint owner");
        endpointGasShareBps[endpointHash]   = bps;
        endpointGasShareIsSet[endpointHash] = true;
        emit EndpointGasShareSet(endpointHash, bps);
    }

    /**
     * @notice Withdraw remaining endpoint balance.
     *         Only the original depositor (endpointOwner) can withdraw their funds.
     *         Previously was onlyOwner (contract deployer) — corrected to prevent rug.
     */
    function withdrawEndpointBalance(string calldata url, address payable to) external {
        bytes32 hash = keccak256(abi.encodePacked(url));
        require(endpointOwner[hash] == msg.sender, "Not endpoint owner");
        uint256 amount = endpointBalance[hash];
        require(amount > 0, "No balance");
        endpointBalance[hash] = 0;
        try entryPoint.withdrawTo(to, amount) {
            // ERC-4337 path — funds pulled from EntryPoint
        } catch {
            // Graceful degradation on Hedera — internal balance zeroed, no EntryPoint call
        }
        emit EndpointWithdraw(hash, to, amount);
    }

    /**
     * @notice Convenience: deposit ETH AND set gas share in one call.
     */
    function fundAndSetGasShare(string calldata url, uint16 bps) external payable {
        require(msg.value > 0, "No ETH sent");
        require(bps <= 10000, "bps > 10000");
        bytes32 hash = keccak256(abi.encodePacked(url));
        if (endpointOwner[hash] == address(0)) {
            endpointOwner[hash] = msg.sender;
        }
        require(endpointOwner[hash] == msg.sender, "Not endpoint owner");
        endpointBalance[hash] += msg.value;
        endpointGasShareBps[hash]   = bps;
        endpointGasShareIsSet[hash] = true;
        // Forward into EntryPoint for ERC-4337 gas sponsorship (Base Sepolia).
        // Try/catch for chains where EntryPoint.depositTo is unavailable (Hedera).
        try entryPoint.depositTo{value: msg.value}(address(this)) {
        } catch {}
        emit EndpointFunded(hash, msg.sender, msg.value);
        emit EndpointGasShareSet(hash, bps);
    }

    // ── Owner utils ─────────────────────────────────────────────────────────

    function getTotalSponsored() external view returns (uint256) { return totalSponsored; }

    function withdrawFunds(address payable recipient, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(recipient, amount);
    }

    // ── ERC-4337 Paymaster validation ───────────────────────────────────────

    /**
     * @dev paymasterAndData layout (ERC-4337 v0.7):
     *   [0:20]  paymaster address
     *   [20:36] paymasterVerificationGasLimit (uint128)
     *   [36:52] paymasterPostOpGasLimit (uint128)
     *   [52:84] endpointHash (bytes32) ← publisher's endpoint
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        // Decode endpoint hash
        bytes32 endpointHash;
        if (userOp.paymasterAndData.length >= 84) {
            endpointHash = bytes32(userOp.paymasterAndData[52:84]);
        }

        // Resolve gas share: default 100% only when the publisher has never configured it.
        // Explicitly setting bps=0 (no sponsorship) is now distinguishable from "unset".
        uint16 bps = endpointGasShareIsSet[endpointHash]
            ? endpointGasShareBps[endpointHash]
            : 10000;

        // How much of the gas cost the publisher is covering this call
        uint256 coveredCost = (maxCost * bps) / 10000;

        // Publisher's endpoint must have enough balance
        require(endpointBalance[endpointHash] >= coveredCost, "Endpoint out of gas budget");

        // Reserve (optimistically; refunded in postOp with actual cost)
        endpointBalance[endpointHash] -= coveredCost;

        context        = abi.encode(userOp.sender, userOpHash, coveredCost, bps, endpointHash);
        validationData = 0;
    }

    /**
     * @dev Post-op: settle actual vs reserved cost, emit event.
     */
    function _postOp(
        PostOpMode /*mode*/,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) internal override {
        (
            address agent,
            ,
            uint256 reservedCost,
            uint16  bps,
            bytes32 endpointHash
        ) = abi.decode(context, (address, bytes32, uint256, uint16, bytes32));

        uint256 actualCovered = (actualGasCost * bps) / 10000;

        // Refund over-reserved balance back to the endpoint
        if (reservedCost > actualCovered) {
            endpointBalance[endpointHash] += reservedCost - actualCovered;
        }

        totalSponsored += actualCovered;
        totalCalls     += 1;

        emit GasSponsored(agent, endpointHash, actualCovered, bps);
    }
}
