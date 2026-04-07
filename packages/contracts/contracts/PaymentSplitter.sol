// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PaymentSplitter
 * @notice Receives USDC payments from agents, splits automatically:
 *         - 95% to the endpoint publisher
 *         - 5% to the AgentGate platform
 *
 *         The platform fee % is configurable by the owner.
 *         Publishers register their wallet address per endpoint.
 */
contract PaymentSplitter is Ownable {
    IERC20 public immutable usdc;
    address public platformWallet;
    uint16 public platformFeeBps; // basis points: 500 = 5%

    // endpointId → publisher wallet
    mapping(uint256 => address) public endpointPublisher;

    // Track revenue
    mapping(uint256 => uint256) public endpointRevenue;     // total USDC received per endpoint
    mapping(address => uint256) public publisherEarnings;   // total USDC earned per publisher
    uint256 public totalPlatformRevenue;
    uint256 public totalPayments;

    event PaymentReceived(
        uint256 indexed endpointId,
        address indexed agent,
        uint256 total,
        uint256 publisherAmount,
        uint256 platformAmount
    );
    event PublisherRegistered(uint256 indexed endpointId, address indexed publisher);
    event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);
    event PlatformWalletUpdated(address oldWallet, address newWallet);

    constructor(
        address _usdc,
        address _platformWallet,
        uint16 _platformFeeBps
    ) Ownable(msg.sender) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_platformWallet != address(0), "Invalid platform wallet");
        require(_platformFeeBps <= 2000, "Fee too high (max 20%)");
        usdc = IERC20(_usdc);
        platformWallet = _platformWallet;
        platformFeeBps = _platformFeeBps;
    }

    /**
     * @notice Register the publisher wallet for an endpoint.
     *         Only callable by owner (server/deployer sets this when endpoint is published).
     */
    function registerPublisher(uint256 endpointId, address publisher) external onlyOwner {
        require(publisher != address(0), "Invalid publisher");
        endpointPublisher[endpointId] = publisher;
        emit PublisherRegistered(endpointId, publisher);
    }

    /**
     * @notice Pay for an API call. Agent approves USDC, then calls this.
     *         Splits: (100% - fee) to publisher, fee to platform.
     *
     * @param endpointId  The endpoint being called
     * @param amount      Total USDC amount (6 decimals)
     */
    function pay(uint256 endpointId, uint256 amount) external {
        require(amount > 0, "Zero amount");
        address publisher = endpointPublisher[endpointId];
        require(publisher != address(0), "Endpoint not registered");

        uint256 platformAmount = (amount * platformFeeBps) / 10000;
        uint256 publisherAmount = amount - platformAmount;

        // Transfer from agent to publisher + platform in one tx
        require(usdc.transferFrom(msg.sender, publisher, publisherAmount), "Publisher transfer failed");
        if (platformAmount > 0) {
            require(usdc.transferFrom(msg.sender, platformWallet, platformAmount), "Platform transfer failed");
        }

        endpointRevenue[endpointId] += amount;
        publisherEarnings[publisher] += publisherAmount;
        totalPlatformRevenue += platformAmount;
        totalPayments += 1;

        emit PaymentReceived(endpointId, msg.sender, amount, publisherAmount, platformAmount);
    }

    // ── Admin functions ────────────────────────────────────────────────────────

    function setPlatformFee(uint16 newBps) external onlyOwner {
        require(newBps <= 2000, "Fee too high (max 20%)");
        emit PlatformFeeUpdated(platformFeeBps, newBps);
        platformFeeBps = newBps;
    }

    function setPlatformWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "Invalid wallet");
        emit PlatformWalletUpdated(platformWallet, newWallet);
        platformWallet = newWallet;
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    function getPaymentBreakdown(uint256 amount) external view returns (
        uint256 publisherAmount,
        uint256 platformAmount
    ) {
        platformAmount = (amount * platformFeeBps) / 10000;
        publisherAmount = amount - platformAmount;
    }
}
