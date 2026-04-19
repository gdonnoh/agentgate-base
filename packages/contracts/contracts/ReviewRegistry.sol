// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ReviewRegistry
 * @notice On-chain rating system for AgentGate endpoints and publishers.
 *
 *         Anti-sybil: only addresses verified through the trusted relayer can rate.
 *         The relayer (AgentGate server) verifies WorldID before submitting ratings,
 *         ensuring 1 real human = 1 vote per endpoint.
 *
 *         - Each agent can rate each endpoint once (update allowed, not delete)
 *         - Score: 1-5 (stars)
 *         - Optional comment hash (IPFS CID or keccak of comment stored off-chain)
 *         - Publisher reputation = average across all their endpoints
 */
contract ReviewRegistry is Ownable {

    struct Review {
        address reviewer;
        uint256 endpointId;
        uint8 score;            // 1-5
        bytes32 commentHash;    // optional
        uint256 timestamp;
    }

    /// @notice Trusted relayer that submits WorldID-verified ratings
    address public trustedRelayer;

    // endpointId → list of reviews
    mapping(uint256 => Review[]) public endpointReviews;

    // endpointId → reviewer → index in array (for update)
    mapping(uint256 => mapping(address => uint256)) private reviewIndex;
    mapping(uint256 => mapping(address => bool)) public hasReviewed;

    // Aggregate stats
    mapping(uint256 => uint256) public endpointTotalScore;
    mapping(uint256 => uint256) public endpointReviewCount;
    mapping(address => uint256) public publisherTotalScore;
    mapping(address => uint256) public publisherReviewCount;

    event ReviewSubmitted(
        uint256 indexed endpointId,
        address indexed reviewer,
        address indexed publisher,
        uint8 score,
        bytes32 commentHash
    );

    event ReviewUpdated(
        uint256 indexed endpointId,
        address indexed reviewer,
        uint8 oldScore,
        uint8 newScore
    );

    constructor() Ownable(msg.sender) {}

    function setTrustedRelayer(address _relayer) external onlyOwner {
        trustedRelayer = _relayer;
    }

    /**
     * @notice Submit a WorldID-verified rating. Only callable by the trusted relayer
     *         or the reviewer directly (for decentralized fallback).
     *
     * @param reviewer    The agent wallet (verified by relayer via WorldID)
     * @param endpointId  The endpoint to rate
     * @param publisher   The publisher address
     * @param score       Rating 1-5
     * @param commentHash Optional comment hash
     */
    function rateVerified(
        address reviewer,
        uint256 endpointId,
        address publisher,
        uint8 score,
        bytes32 commentHash
    ) external {
        require(msg.sender == trustedRelayer || msg.sender == owner(), "Only trusted relayer");
        require(score >= 1 && score <= 5, "Score must be 1-5");
        require(reviewer != publisher, "Cannot rate your own endpoint");

        _submitRating(reviewer, endpointId, publisher, score, commentHash);
    }

    // R2-I: the public `rate()` function was removed. It allowed unlimited
    // sybil ratings (1 wallet = 1 rating, but wallet creation is free), which
    // defeated the anti-sybil purpose of the registry. Ratings must go
    // through rateVerified() from the trusted relayer, which gates on
    // WorldID so each real human can only rate an endpoint once.

    function _submitRating(
        address reviewer,
        uint256 endpointId,
        address publisher,
        uint8 score,
        bytes32 commentHash
    ) internal {
        if (hasReviewed[endpointId][reviewer]) {
            // Update existing
            uint256 idx = reviewIndex[endpointId][reviewer];
            Review storage existing = endpointReviews[endpointId][idx];
            uint8 oldScore = existing.score;

            endpointTotalScore[endpointId] = endpointTotalScore[endpointId] - oldScore + score;
            publisherTotalScore[publisher] = publisherTotalScore[publisher] - oldScore + score;

            existing.score = score;
            existing.commentHash = commentHash;
            existing.timestamp = block.timestamp;

            emit ReviewUpdated(endpointId, reviewer, oldScore, score);
        } else {
            // New review
            uint256 idx = endpointReviews[endpointId].length;
            endpointReviews[endpointId].push(Review({
                reviewer: reviewer,
                endpointId: endpointId,
                score: score,
                commentHash: commentHash,
                timestamp: block.timestamp
            }));

            reviewIndex[endpointId][reviewer] = idx;
            hasReviewed[endpointId][reviewer] = true;

            endpointTotalScore[endpointId] += score;
            endpointReviewCount[endpointId] += 1;
            publisherTotalScore[publisher] += score;
            publisherReviewCount[publisher] += 1;

            emit ReviewSubmitted(endpointId, reviewer, publisher, score, commentHash);
        }
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    function endpointAvgRating(uint256 endpointId) external view returns (uint256) {
        if (endpointReviewCount[endpointId] == 0) return 0;
        return (endpointTotalScore[endpointId] * 100) / endpointReviewCount[endpointId];
    }

    function publisherAvgRating(address publisher) external view returns (uint256) {
        if (publisherReviewCount[publisher] == 0) return 0;
        return (publisherTotalScore[publisher] * 100) / publisherReviewCount[publisher];
    }

    function getEndpointReviews(uint256 endpointId) external view returns (Review[] memory) {
        return endpointReviews[endpointId];
    }

    function getReviewCount(uint256 endpointId) external view returns (uint256) {
        return endpointReviewCount[endpointId];
    }
}
