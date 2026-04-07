// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PublisherRegistry
 * @notice Registry for API publishers and their x402-protected endpoints.
 *         Publishers register endpoints with prices and optional Paymaster addresses.
 */
contract PublisherRegistry is Ownable {
    struct Endpoint {
        uint256 id;
        address publisher;
        string url;
        uint256 pricePerCall; // USD quote, 6 decimals ($0.01 = 10000); off-chain settles in HBAR
        address paymasterAddress; // 0x0 if no paymaster
        bool isActive;
        uint256 totalCalls;
        uint256 totalRevenue;
        uint256 createdAt;
        bool requireWorldId; // if true, only WorldID-verified agents can access
    }

    uint256 public nextEndpointId;
    mapping(uint256 => Endpoint) public endpoints;
    mapping(address => uint256[]) public publisherEndpoints;

    /// @notice Address allowed to call recordCall (set to server/relayer wallet by owner).
    address public trustedCaller;

    // Events
    event EndpointRegistered(
        uint256 indexed id,
        address indexed publisher,
        string url,
        uint256 pricePerCall,
        address paymasterAddress
    );
    event EndpointDeactivated(uint256 indexed id, address indexed publisher);
    event EndpointActivated(uint256 indexed id, address indexed publisher);
    event WorldIdRequirementSet(uint256 indexed id, bool required);
    event PaymasterUpdated(uint256 indexed id, address paymasterAddress);
    event CallRecorded(uint256 indexed id, address indexed caller, uint256 revenue);

    constructor() Ownable(msg.sender) {}

    /// @notice Authorize a server/relayer address to call recordCall.
    function setTrustedCaller(address _caller) external onlyOwner {
        trustedCaller = _caller;
    }

    modifier onlyPublisher(uint256 endpointId) {
        require(endpoints[endpointId].publisher == msg.sender, "Not endpoint publisher");
        _;
    }

    /**
     * @notice Register a new API endpoint
     * @param url The API endpoint URL
     * @param pricePerCall USD amount, 6 decimals (settlement is HBAR off-chain)
     * @param paymasterAddress Address of the Paymaster (0x0 if none)
     */
    function registerEndpoint(
        string calldata url,
        uint256 pricePerCall,
        address paymasterAddress
    ) external returns (uint256 id) {
        id = nextEndpointId++;

        endpoints[id] = Endpoint({
            id: id,
            publisher: msg.sender,
            url: url,
            pricePerCall: pricePerCall,
            paymasterAddress: paymasterAddress,
            isActive: true,
            totalCalls: 0,
            totalRevenue: 0,
            createdAt: block.timestamp,
            requireWorldId: false
        });

        publisherEndpoints[msg.sender].push(id);

        emit EndpointRegistered(id, msg.sender, url, pricePerCall, paymasterAddress);
    }

    /**
     * @notice Deactivate an endpoint
     */
    function deactivateEndpoint(uint256 endpointId) external onlyPublisher(endpointId) {
        require(endpoints[endpointId].isActive, "Already inactive");
        endpoints[endpointId].isActive = false;
        emit EndpointDeactivated(endpointId, msg.sender);
    }

    /**
     * @notice Reactivate an endpoint
     */
    function activateEndpoint(uint256 endpointId) external onlyPublisher(endpointId) {
        require(!endpoints[endpointId].isActive, "Already active");
        endpoints[endpointId].isActive = true;
        emit EndpointActivated(endpointId, msg.sender);
    }

    /**
     * @notice Update the paymaster address for an endpoint
     */
    function updatePaymaster(uint256 endpointId, address paymasterAddress) external onlyPublisher(endpointId) {
        endpoints[endpointId].paymasterAddress = paymasterAddress;
        emit PaymasterUpdated(endpointId, paymasterAddress);
    }

    /**
     * @notice Set WorldID requirement for an endpoint
     */
    function setRequireWorldId(uint256 endpointId, bool required) external onlyPublisher(endpointId) {
        endpoints[endpointId].requireWorldId = required;
        emit WorldIdRequirementSet(endpointId, required);
    }

    /**
     * @notice Record a successful API call. Only callable by owner or the designated
     *         trustedCaller (server/relayer). Public access was a griefable stat inflation vector.
     */
    function recordCall(uint256 endpointId) external {
        require(
            msg.sender == owner() || msg.sender == trustedCaller,
            "recordCall: not authorized"
        );
        require(endpoints[endpointId].isActive, "Endpoint inactive");
        endpoints[endpointId].totalCalls += 1;
        endpoints[endpointId].totalRevenue += endpoints[endpointId].pricePerCall;
        emit CallRecorded(endpointId, msg.sender, endpoints[endpointId].pricePerCall);
    }

    /**
     * @notice Get endpoint details
     */
    function getEndpoint(uint256 endpointId) external view returns (Endpoint memory) {
        return endpoints[endpointId];
    }

    /**
     * @notice Get all endpoint IDs for a publisher
     */
    function getPublisherEndpoints(address publisher) external view returns (uint256[] memory) {
        return publisherEndpoints[publisher];
    }

    /**
     * @notice Get total number of endpoints
     */
    function getTotalEndpoints() external view returns (uint256) {
        return nextEndpointId;
    }

    /**
     * @notice Check if an endpoint has a paymaster (sponsored gas)
     */
    function isSponsored(uint256 endpointId) external view returns (bool) {
        return endpoints[endpointId].paymasterAddress != address(0) && endpoints[endpointId].isActive;
    }
}
