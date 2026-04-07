// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReviewRegistry
 * @notice On-chain rating system for AgentGate endpoints and publishers.
 *         Agents rate endpoints after using them. Ratings are immutable and public.
 *
 *         - Each agent can rate each endpoint once (update allowed, not delete)
 *         - Score: 1-5 (stars)
 *         - Optional comment hash (IPFS CID or keccak of comment stored off-chain)
 *         - Publisher reputation = average across all their endpoints
 */
contract ReviewRegistry {

    struct Review {
        address reviewer;       // agent who left the review
        uint256 endpointId;
        uint8 score;            // 1-5
        bytes32 commentHash;    // optional: keccak256 of comment or IPFS CID
        uint256 timestamp;
    }

    // endpointId → list of reviews
    mapping(uint256 => Review[]) public endpointReviews;

    // endpointId → reviewer → index in endpointReviews array (for update)
    mapping(uint256 => mapping(address => uint256)) private reviewIndex;
    mapping(uint256 => mapping(address => bool)) public hasReviewed;

    // Aggregate stats (kept updated to avoid looping)
    mapping(uint256 => uint256) public endpointTotalScore;
    mapping(uint256 => uint256) public endpointReviewCount;

    // Publisher stats: publisher address → aggregate
    // Updated by passing publisher address in the rate call
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

    /**
     * @notice Rate an endpoint. Each agent can rate each endpoint once.
     * @param endpointId  The endpoint to rate
     * @param publisher   The publisher address (passed by caller, verified off-chain)
     * @param score       Rating 1-5
     * @param commentHash Optional comment hash (pass bytes32(0) for none)
     */
    function rate(
        uint256 endpointId,
        address publisher,
        uint8 score,
        bytes32 commentHash
    ) external {
        require(score >= 1 && score <= 5, "Score must be 1-5");
        require(msg.sender != publisher, "Cannot rate your own endpoint");

        if (hasReviewed[endpointId][msg.sender]) {
            // Update existing review
            uint256 idx = reviewIndex[endpointId][msg.sender];
            Review storage existing = endpointReviews[endpointId][idx];
            uint8 oldScore = existing.score;

            // Update aggregates
            endpointTotalScore[endpointId] = endpointTotalScore[endpointId] - oldScore + score;
            publisherTotalScore[publisher] = publisherTotalScore[publisher] - oldScore + score;

            existing.score = score;
            existing.commentHash = commentHash;
            existing.timestamp = block.timestamp;

            emit ReviewUpdated(endpointId, msg.sender, oldScore, score);
        } else {
            // New review
            uint256 idx = endpointReviews[endpointId].length;
            endpointReviews[endpointId].push(Review({
                reviewer: msg.sender,
                endpointId: endpointId,
                score: score,
                commentHash: commentHash,
                timestamp: block.timestamp
            }));

            reviewIndex[endpointId][msg.sender] = idx;
            hasReviewed[endpointId][msg.sender] = true;

            endpointTotalScore[endpointId] += score;
            endpointReviewCount[endpointId] += 1;
            publisherTotalScore[publisher] += score;
            publisherReviewCount[publisher] += 1;

            emit ReviewSubmitted(endpointId, msg.sender, publisher, score, commentHash);
        }
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    /// @notice Average rating for an endpoint (multiplied by 100 for precision: 450 = 4.50)
    function endpointAvgRating(uint256 endpointId) external view returns (uint256) {
        if (endpointReviewCount[endpointId] == 0) return 0;
        return (endpointTotalScore[endpointId] * 100) / endpointReviewCount[endpointId];
    }

    /// @notice Average rating for a publisher (multiplied by 100)
    function publisherAvgRating(address publisher) external view returns (uint256) {
        if (publisherReviewCount[publisher] == 0) return 0;
        return (publisherTotalScore[publisher] * 100) / publisherReviewCount[publisher];
    }

    /// @notice Get all reviews for an endpoint
    function getEndpointReviews(uint256 endpointId) external view returns (Review[] memory) {
        return endpointReviews[endpointId];
    }

    /// @notice Get review count for an endpoint
    function getReviewCount(uint256 endpointId) external view returns (uint256) {
        return endpointReviewCount[endpointId];
    }
}
