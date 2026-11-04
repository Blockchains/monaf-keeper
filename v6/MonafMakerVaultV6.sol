// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20V6 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface IPermit2V6 { function approve(address token, address spender, uint160 amount, uint48 expiration) external; }
interface IStateViewV6 { function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee); }
interface IPosmV6 {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function poolManager() external view returns (address);
}

/// @title monaf maker vault V6: Uniswap v4 native MON / ERC20 (MON/USDC 0.05% tickSpacing 10 on Monad) (ALPHA, unaudited, no guaranteed returns)
/// @notice V5 safety model, generalised to multi-tick ranges and any native-MON/ERC20 pool fixed at deploy:
///   - ONE immutable pool key (currency0 = native MON, currency1 = `token1`, fee, tickSpacing, no hooks).
///   - Keeper may ONLY place single-sided ranges near spot (width, distance, size and count capped by the owner), close them back
///     INTO this vault, move them (close + place in one tx) and pause. It can never withdraw, unpause, activate or change limits/keeper.
///   - Only the immutable owner funds (deposit / token transfer), activates, unpauses, changes limits/keeper/approvals, and withdraws;
///     every withdrawal goes to the owner. withdrawAll = pause + deactivate + close everything + send all to the owner.
///   - One long-lived token1 -> Permit2 -> PositionManager approval (owner can revoke / re-grant). Deploys INACTIVE.
///   - MON is only accepted from the owner (deposit / plain send) and from the v4 PositionManager / PoolManager (refunds, closes).
contract MonafMakerVaultV6 {
    IPosmV6 public immutable posm;
    IPermit2V6 public immutable permit2;
    IStateViewV6 public immutable stateView;
    address public immutable poolManager;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable spacing;
    bytes32 public immutable poolId;
    address public immutable owner;
    uint8 public constant HARD_MAX_OPEN = 4;
    uint8 public constant VERSION = 6;

    // slot 0: keeper + per-order cap (MON-eq wei)
    address public keeper;
    uint96 public maxPerOrderMonEq;
    // slot 1: hot state. Distances / widths in ticks.
    struct S { bool active; bool paused; uint8 lock; uint8 maxOpen; int24 maxDistanceTicks; int24 maxWidthTicks; uint8 n; uint40 id0; uint40 id1; uint40 id2; uint40 id3; }
    S internal s;

    struct Order { int24 tickLower; int24 tickUpper; uint128 liquidity; uint128 amountMax; }

    event Placed(uint256 indexed tokenId, int24 tickLower, int24 tickUpper, bool sellMon, uint128 liquidity, uint256 amountMax);
    event Closed(uint256 indexed tokenId, uint256 mon, uint256 amount1);
    event Paused(bool on, address by);
    event Active(bool on);
    event KeeperSet(address keeper);
    event Limits(int24 maxDistanceTicks, int24 maxWidthTicks, uint256 maxPerOrderMonEq, uint8 maxOpen);
    event Deposited(uint256 mon);
    event Withdrawn(address token, uint256 amount);
    event Approvals(bool on);

    error NotOwner(); error NotKeeper(); error Inactive(); error IsPaused(); error TooFar(); error TooBig(); error NotOneSided();
    error TooMany(); error NotOurs(); error TransferFailed(); error Reentrant(); error BadLimits(); error ZeroSize(); error IdOverflow();
    error BadRange(); error NotAllowed();

    constructor(address owner_, address keeper_, IPosmV6 posm_, IPermit2V6 permit2_, IStateViewV6 stateView_, address token1_,
        uint24 fee_, int24 spacing_, int24 maxDistanceTicks_, int24 maxWidthTicks_, uint96 maxPerOrderMonEq_, uint8 maxOpen_) {
        if (owner_ == address(0) || token1_ == address(0) || spacing_ <= 0) revert BadLimits();
        owner = owner_; keeper = keeper_; posm = posm_; permit2 = permit2_; stateView = stateView_; token1 = token1_; fee = fee_; spacing = spacing_;
        poolManager = posm_.poolManager();
        poolId = keccak256(abi.encode(address(0), token1_, fee_, spacing_, address(0)));
        s.lock = 1;
        _limits(maxDistanceTicks_, maxWidthTicks_, maxPerOrderMonEq_, maxOpen_);
        _approve(true);
    }

    // ------------------------------------------------------------ views
    function active() external view returns (bool) { return s.active; }
    function paused() external view returns (bool) { return s.paused; }
    function maxOpen() external view returns (uint8) { return s.maxOpen; }
    function maxDistanceTicks() external view returns (int24) { return s.maxDistanceTicks; }
    function maxWidthTicks() external view returns (int24) { return s.maxWidthTicks; }
    function openCount() external view returns (uint256) { return s.n; }
    function openIds(uint256 i) external view returns (uint256) { S memory m = s; if (i >= m.n) revert NotOurs(); return _id(m, i); }
    function spot() public view returns (uint160 sqrtP, int24 tick) { (sqrtP, tick,,) = stateView.getSlot0(poolId); }
    /// @notice One-call keeper snapshot.
    function snapshot() external view returns (bool active_, bool paused_, int24 tick, uint160 sqrtP, uint256 mon, uint256 bal1, uint256[] memory ids) {
        S memory m = s; (sqrtP, tick) = spot(); active_ = m.active; paused_ = m.paused;
        mon = address(this).balance; bal1 = IERC20V6(token1).balanceOf(address(this));
        ids = new uint256[](m.n); for (uint256 i; i < m.n;) { ids[i] = _id(m, i); unchecked { ++i; } }
    }
    /// @notice token1 raw units -> MON wei at sqrtP (price = token1 per MON = (sqrtP/2^96)^2).
    function token1ToMonEq(uint256 amt, uint160 sqrtP) public pure returns (uint256) { return amt * (1 << 96) / sqrtP * (1 << 96) / sqrtP; }

    // ------------------------------------------------------------ keeper (bounded)
    function _enter(bool keeperAllowed) internal returns (S memory m) {
        m = s;
        if (m.lock != 1) revert Reentrant();
        if (keeperAllowed) {
            if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
            if (!m.active) revert Inactive();
            if (m.paused) revert IsPaused();
        } else if (msg.sender != owner) revert NotOwner();
        s.lock = 2;
    }
    function _exit(S memory m) internal { m.lock = 1; s = m; }

    /// @notice Mint one single-sided [tickLower, tickUpper) position (above spot: MON only; at/below spot: token1 only).
    function place(Order calldata o, uint256 deadline) external returns (uint256 tokenId) {
        S memory m = _enter(true);
        Order[] memory os = new Order[](1); os[0] = o;
        tokenId = _placeMany(m, os, deadline);
        _exit(m);
    }
    function close(uint256 tokenId, uint256 deadline) external returns (uint256 mon, uint256 a1) {
        S memory m = _enter(true); (mon, a1) = _close(m, tokenId, deadline); _exit(m);
    }
    /// @notice Move one order: close `tokenId` into the vault and mint `o` in the same tx (gas: one tx instead of two).
    function moveOrder(uint256 tokenId, Order calldata o, uint256 deadline) external returns (uint256 newId) {
        S memory m = _enter(true); _close(m, tokenId, deadline);
        Order[] memory os = new Order[](1); os[0] = o; newId = _placeMany(m, os, deadline); _exit(m);
    }
    /// @notice Batch: close `closeIds` (into this vault), then mint all `orders` in ONE PositionManager call.
    function execute(uint256[] calldata closeIds, Order[] calldata orders, uint256 deadline) external returns (uint256 firstId) {
        S memory m = _enter(true);
        uint256 nc = closeIds.length;
        for (uint256 i; i < nc;) { _close(m, closeIds[i], deadline); unchecked { ++i; } }
        if (orders.length != 0) firstId = _placeMany(m, orders, deadline);
        _exit(m);
    }
    /// @notice The keeper can pause (stop rules) but never unpause, activate, withdraw or change limits.
    function keeperPause() external { if (msg.sender != keeper) revert NotKeeper(); s.paused = true; emit Paused(true, msg.sender); }

    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct Ctx { uint160 sqrtP; int24 tick; uint256 cap; int24 dist; int24 maxW; uint256 value; uint256 firstId; }

    function _placeMany(S memory m, Order[] memory orders, uint256 deadline) internal returns (uint256 firstId) {
        uint256 k = orders.length;
        if (m.n + k > m.maxOpen) revert TooMany();
        Ctx memory c; (c.sqrtP, c.tick) = spot(); c.cap = maxPerOrderMonEq; c.dist = m.maxDistanceTicks; c.maxW = m.maxWidthTicks;
        c.firstId = firstId = posm.nextTokenId();
        if (firstId + k > type(uint40).max) revert IdOverflow();
        bytes memory actions = new bytes(k + 2);
        bytes[] memory p = new bytes[](k + 2);
        for (uint256 i; i < k;) { actions[i] = 0x02; p[i] = _mint(m, c, orders[i], i); unchecked { ++i; } } // MINT_POSITION
        actions[k] = 0x0d; p[k] = abi.encode(address(0), token1); // SETTLE_PAIR (token1 via the standing Permit2 allowance)
        if (c.value != 0) { actions[k + 1] = 0x14; p[k + 1] = abi.encode(address(0), address(this)); } // SWEEP native refund -> vault
        else { assembly { mstore(actions, add(k, 1)) mstore(p, add(k, 1)) } }
        posm.modifyLiquidities{value: c.value}(abi.encode(actions, p), deadline);
    }

    function _mint(S memory m, Ctx memory c, Order memory o, uint256 i) internal returns (bytes memory) {
        bool sellMon = _check(o, c);
        if (sellMon) c.value += o.amountMax;
        uint256 id = c.firstId + i; _push(m, id);
        emit Placed(id, o.tickLower, o.tickUpper, sellMon, o.liquidity, o.amountMax);
        return abi.encode(PoolKey(address(0), token1, fee, spacing, address(0)), o.tickLower, o.tickUpper, uint256(o.liquidity),
            sellMon ? o.amountMax : uint128(0), sellMon ? uint128(0) : o.amountMax, address(this), bytes(""));
    }

    function _check(Order memory o, Ctx memory c) internal view returns (bool sellMon) {
        if (o.amountMax == 0 || o.liquidity == 0) revert ZeroSize();
        int24 w = o.tickUpper - o.tickLower;
        if (w <= 0 || w > c.maxW || o.tickLower % spacing != 0 || o.tickUpper % spacing != 0) revert BadRange();
        if (o.tickLower > c.tick) { if (o.tickLower - c.tick > c.dist) revert TooFar(); if (o.amountMax > c.cap) revert TooBig(); return true; }
        if (o.tickUpper <= c.tick) { if (c.tick - o.tickUpper > c.dist) revert TooFar(); if (token1ToMonEq(o.amountMax, c.sqrtP) > c.cap) revert TooBig(); return false; }
        revert NotOneSided();
    }

    function _close(S memory m, uint256 tokenId, uint256 deadline) internal returns (uint256 mon, uint256 a1) {
        _remove(m, tokenId);
        uint256 m0 = address(this).balance; uint256 b0 = IERC20V6(token1).balanceOf(address(this));
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        p[1] = abi.encode(address(0), token1, address(this));
        posm.modifyLiquidities(abi.encode(hex"0311", p), deadline); // BURN_POSITION, TAKE_PAIR -> this vault
        unchecked { mon = address(this).balance - m0; a1 = IERC20V6(token1).balanceOf(address(this)) - b0; }
        emit Closed(tokenId, mon, a1);
    }

    // packed open-id list helpers (n <= 4)
    function _id(S memory m, uint256 i) internal pure returns (uint256) { return i == 0 ? m.id0 : i == 1 ? m.id1 : i == 2 ? m.id2 : m.id3; }
    function _set(S memory m, uint256 i, uint40 v) internal pure { if (i == 0) m.id0 = v; else if (i == 1) m.id1 = v; else if (i == 2) m.id2 = v; else m.id3 = v; }
    function _push(S memory m, uint256 id) internal pure { _set(m, m.n, uint40(id)); unchecked { ++m.n; } }
    function _remove(S memory m, uint256 id) internal pure {
        uint256 n = m.n; uint256 i;
        for (; i < n;) { if (_id(m, i) == id) break; unchecked { ++i; } }
        if (i == n) revert NotOurs();
        unchecked { _set(m, i, uint40(_id(m, n - 1))); _set(m, n - 1, 0); m.n = uint8(n - 1); }
    }

    // ------------------------------------------------------------ owner
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    function deposit() external payable onlyOwner { emit Deposited(msg.value); }
    function setActive(bool on) external onlyOwner { s.active = on; emit Active(on); }
    function setPaused(bool on) external onlyOwner { s.paused = on; emit Paused(on, msg.sender); }
    function setKeeper(address k) external onlyOwner { keeper = k; emit KeeperSet(k); }
    function setLimits(int24 dist, int24 maxW, uint96 perOrder, uint8 mo) external onlyOwner { _limits(dist, maxW, perOrder, mo); }
    function _limits(int24 dist, int24 maxW, uint96 perOrder, uint8 mo) internal {
        if (dist < 0 || maxW < spacing || mo > HARD_MAX_OPEN) revert BadLimits();
        s.maxDistanceTicks = dist; s.maxWidthTicks = maxW; maxPerOrderMonEq = perOrder; s.maxOpen = mo; emit Limits(dist, maxW, perOrder, mo);
    }
    /// @notice Owner can revoke (false) or re-grant (true) the standing token1 -> Permit2 -> PositionManager allowance.
    function setApprovals(bool on) external onlyOwner { _approve(on); }
    function _approve(bool on) internal {
        if (!IERC20V6(token1).approve(address(permit2), on ? type(uint256).max : 0)) revert TransferFailed();
        permit2.approve(token1, address(posm), on ? type(uint160).max : 0, on ? type(uint48).max : 0);
        emit Approvals(on);
    }
    /// @notice Owner can always close positions, even when paused/inactive.
    function ownerClose(uint256 tokenId, uint256 deadline) external returns (uint256 mon, uint256 a1) {
        S memory m = _enter(false); (mon, a1) = _close(m, tokenId, deadline); _exit(m);
    }
    function withdraw(address token, uint256 amount) external { S memory m = _enter(false); _send(token, amount); _exit(m); }
    /// @notice Pause + deactivate, close every open position, and send ALL MON and token1 to the owner.
    function withdrawAll(uint256 deadline) external {
        S memory m = _enter(false);
        m.paused = true; m.active = false; emit Paused(true, msg.sender); emit Active(false);
        while (m.n != 0) _close(m, _id(m, m.n - 1), deadline);
        _send(token1, IERC20V6(token1).balanceOf(address(this)));
        _send(address(0), address(this).balance);
        _exit(m);
    }
    function _send(address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) { (bool ok,) = owner.call{value: amount}(""); if (!ok) revert TransferFailed(); }
        else if (!IERC20V6(token).transfer(owner, amount)) revert TransferFailed();
        emit Withdrawn(token, amount);
    }
    /// @notice Owner funding, PositionManager refunds (SWEEP) and PoolManager takes (closes) only.
    receive() external payable { if (msg.sender != owner && msg.sender != address(posm) && msg.sender != poolManager) revert NotAllowed(); }
}
