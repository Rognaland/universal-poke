import { depositLyx, depositWbstr, claimPrize, claimMultiple, getDefaultPrizeTokens, getAuthorizedPayout, getSigner, getBalances, getVaultBalance, withdrawFromVault, getPlayerTableIds } from './services.chain.js';
import './style.css';
// Firebase
import './firebase.js';
import { createTable, subscribeOpenTables, subscribeTablePlayers, addPlayerToTable, removePlayerFromTable, subscribeTable, startTable, createAiTable, WBSTR_TOKEN_ADDRESS, getTable, joinOnCreate, subscribeTableChat, addChatMessage, subscribeGameState, playerAction, subscribeActiveTables, listTablePlayers, startAiGameCreate, startAiGameConfirm, subscribePlayerStatsByCategory, recordLeaderboardEntry } from './services.firestore.js';
import { ZERO_ADDRESS } from './config.onchain.js';
import { ethers } from 'ethers';
import ERC725 from '@erc725/erc725.js';
import LSP3ProfileSchema from '@erc725/erc725.js/schemas/LSP3ProfileMetadata.json';

const initApp = async () => {
    const WBSTR_PER_CHIP = 1000;
    const DEFAULT_WBSTR_UNITS_PER_CHIP = 1000000000000000000000n;
    const IPFS_GATEWAY = 'https://api.universalprofile.cloud/ipfs/';
    const FALLBACK_RPC_URL = 'https://rpc.mainnet.lukso.network';
    
    // Token symbol - dynamically loaded from LSP4 metadata (will be WTEST on testnet, WBSTR on mainnet)
    let TOKEN_SYMBOL = 'WBSTR'; // default fallback
    const LSP4_SCHEMA = [
        {
            name: 'LSP4TokenName',
            key: ethers.id('LSP4TokenName'),
            keyType: 'Singleton',
            valueType: 'string',
            valueContent: 'String'
        },
        {
            name: 'LSP4TokenSymbol',
            key: ethers.id('LSP4TokenSymbol'),
            keyType: 'Singleton',
            valueType: 'string',
            valueContent: 'String'
        },
        {
            name: 'LSP4Metadata',
            key: ethers.id('LSP4Metadata'),
            keyType: 'Singleton',
            valueType: 'bytes',
            valueContent: 'VerifiableURI'
        }
    ];
    const authContainer = document.getElementById('auth-container');
    const accountPicker = document.getElementById('account-picker');
    const accountPickerHint = document.getElementById('account-picker-hint');
    const accountsLoadingEl = document.getElementById('accounts-loading');
    const accountsListEl = document.getElementById('accounts-list');
    const accountContinueBtn = document.getElementById('account-continue');
    const connectButton = document.getElementById('connect-button');
    const errorMessage = document.getElementById('error-message');
    const profileDisplay = document.getElementById('profile-display');
    const profileImage = document.getElementById('profile-image');
    const profileName = document.getElementById('profile-name');
    const profileAddressElem = document.getElementById('profile-address');
    const toggleProfileBtn = document.getElementById('toggle-profile');
    const inlineClaimBtn = document.getElementById('btn-claim-inline');
    const inlineClaimFeedback = document.getElementById('claim-feedback');
    const menuTokenCard = document.getElementById('menu-wbstr-card');
    const menuTokenIcon = document.getElementById('menu-wbstr-icon');
    const menuTokenFallback = document.getElementById('menu-wbstr-fallback');
    const menuTokenNameEl = document.getElementById('menu-wbstr-name');
    const menuTokenSymbolEl = document.getElementById('menu-wbstr-symbol');
    const menuTokenAddressEl = document.getElementById('menu-wbstr-address');
    const menuTokenBalanceEl = document.getElementById('menu-wbstr-balance');
    const menuTokenChipsEl = document.getElementById('menu-wbstr-chips');
    const menuClaimBtn = document.getElementById('menu-claim-all');
    const menuClaimNote = document.getElementById('menu-claim-note');
    const tableAreaEl = document.querySelector('.table-area');
    const communityCardsEl = document.getElementById('community-cards');
    const potContainerEl = document.getElementById('pot-container');
    const potEl = document.getElementById('pot');
    const sidePotsEl = document.getElementById('side-pots');
    const gameMessageEl = document.getElementById('game-message');
    const phaseBannerEl = document.getElementById('phase-banner');
    const seatEntries = new Map();
    const tokenMetadataCache = new Map();
    let fallbackMetadataProvider = null;
    let latestClaimSummary = { address: null, timestamp: 0, entries: [], count: 0, hasClaimable: false };
    let claimAllButtonPopup = null;
    if (menuTokenCard) menuTokenCard.style.display = 'none';
    const seatDynamicClasses = ['occupied', 'is-hero', 'opponent', 'is-active-turn', 'is-folded', 'is-out', 'has-bet', 'has-dealer', 'is-bot', 'is-winner', 'showdown-reveal', 'has-tags', 'cards-right'];

    let potHeatTimer = null;
    let aiResultOverlay = null;
    let aiResultCountdownTimer = null;
    Array.from(document.querySelectorAll('.table-area .seat')).forEach((seatNode) => {
        const seatAttr = seatNode.dataset.seat || (seatNode.className.match(/seat-(\d+)/) || [])[1];
        const seatId = Number(seatAttr);
        if (!Number.isFinite(seatId) || seatEntries.has(seatId)) return;
        const entry = {
            id: seatId,
            root: seatNode,
            pod: seatNode.querySelector('.player-pod'),
            name: seatNode.querySelector('.player-name'),
            stack: seatNode.querySelector('.player-stack'),
            cards: seatNode.querySelector('.player-cards'),
            bet: seatNode.querySelector('.player-bet-display'),
            dealer: seatNode.querySelector('.dealer-button-display'),
            tags: seatNode.querySelector('.player-tags') || null,
        };
        seatNode.dataset.player = '';
        seatNode.classList.add('is-empty');
        seatEntries.set(seatId, entry);
    });

    function ensureSeatTags(entry) {
        if (!entry) return null;
        if (entry.tags && entry.tags.isConnected) return entry.tags;
        if (!entry.pod) return null;
        const tagsEl = document.createElement('div');
        tagsEl.className = 'player-tags';
        tagsEl.hidden = true;
        entry.pod.appendChild(tagsEl);
        entry.tags = tagsEl;
        return tagsEl;
    }

    function updateSeatTags(entry, badges) {
        const tagsEl = ensureSeatTags(entry);
        if (!tagsEl) return;
        if (!Array.isArray(badges) || !badges.length) {
            tagsEl.innerHTML = '';
            tagsEl.hidden = true;
            entry.root.classList.remove('has-tags');
            return;
        }
        tagsEl.innerHTML = badges.join('');
        tagsEl.hidden = false;
        entry.root.classList.add('has-tags');
    }

    function clearSeat(entry) {
        if (!entry) return;
        entry.root.classList.remove(...seatDynamicClasses);
        entry.root.classList.add('is-empty');
        entry.root.dataset.player = '';
        if (entry.name) entry.name.textContent = '';
        if (entry.stack) entry.stack.textContent = '';
        if (entry.cards) entry.cards.innerHTML = '';
        if (entry.bet) {
            entry.bet.innerHTML = '';
            entry.bet.dataset.amount = '0';
        }
        if (entry.dealer) entry.dealer.setAttribute('aria-hidden', 'true');
        if (entry.tags) {
            entry.tags.innerHTML = '';
            entry.tags.hidden = true;
        }
    }
    const playerControls = document.getElementById('player-controls');
    const foldBtn = document.getElementById('btn-fold');
    const checkBtn = document.getElementById('btn-check');
    const callBtn = document.getElementById('btn-call');
    const betBtn = document.getElementById('btn-bet');
    const allInBtn = document.getElementById('btn-allin');
    const betSlider = document.getElementById('bet-slider');
    const betAmountInput = document.getElementById('bet-amount-input');
    const betPresetButtons = Array.from(document.querySelectorAll('.bet-presets .preset'));
    const wagerValueEl = document.getElementById('wager-value');
    const actionLogEl = document.getElementById('action-log');
    const toggleLogBtn = document.getElementById('btn-toggle-log');
    const startGameBtn = document.getElementById('btn-start-game');
    const turnTimerEl = document.getElementById('turn-timer');
    const setupPanel = document.getElementById('setup-panel');
    const setupName = document.getElementById('setup-name');
    const setupPlayers = document.getElementById('setup-players');
    const setupStack = document.getElementById('setup-stack');
    const setupSB = document.getElementById('setup-sb');
    const setupBB = document.getElementById('setup-bb');
    const setupToken = document.getElementById('setup-token');
    const setupBuyin = document.getElementById('setup-buyin');
    const setupMinChips = document.getElementById('setup-minchips');
    const setupDate = document.getElementById('setup-date');
    const setupTime = document.getElementById('setup-time');
    const setupGameType = document.getElementById('setup-gametype');

    let profilePopup = null;
    let claimStatusEl = null;
    let claimRewardsButtonPopup = null;
    let profilePopupWbstrEl = null;
    let inlineFeedbackTimer = null;
    let selectedAccount = null;
    let accountOptions = [];
    let phaseBannerTimer = null;
    let turnTimerInterval = null; // Timer to display remaining time

    let cachedPreferredAddress = null;
    let cachedPreferredName = null;
    try {
        cachedPreferredAddress = localStorage.getItem('up.address') || null;
        cachedPreferredName = localStorage.getItem('up.username') || null;
    } catch (_) {
        cachedPreferredAddress = null;
        cachedPreferredName = null;
    }
    function renderGamePlayers(state) {
        if (!seatEntries.size) return;
        if (!state || !state.players) {
            seatEntries.forEach((entry) => clearSeat(entry));
            currentGame.bets = {};
            return;
        }

        const prevBetCache = currentGame.bets || {};
        const previousBetRects = new Map();
        seatEntries.forEach((entry) => {
            const pid = entry?.root?.dataset?.player;
            if (!pid || !entry.bet) return;
            const cachedAmount = Number(entry.bet.dataset?.amount || prevBetCache[pid] || 0);
            if (!(cachedAmount > 0)) return;
            const rect = entry.bet.getBoundingClientRect();
            previousBetRects.set(pid, { rect, amount: cachedAmount });
        });

        seatEntries.forEach((entry) => clearSeat(entry));

        const showdown = state.showdownSummary || {};
        const showdownHands = showdown.hands || {};
        const showdownWinnersSet = new Set(Array.isArray(showdown.winners) ? showdown.winners : []);
        const isShowdownPhase = String(state.phase || '').toLowerCase() === 'showdown';
        const order = Array.isArray(state.order) && state.order.length ? state.order : Object.keys(state.players);
        const seats = order.filter((pid) => state.players[pid]);
        const heroId = currentGame.myDocId;
        const heroIncluded = !!(heroId && seats.includes(heroId));
        
        // Clockwise seat order starting from seat 1 (bottom center) - MAX 8 PLAYERS
        // Based on CSS positions: 1 (you) → 8 → 7 → 6 → 5 → 4 → 3 → 2
        const CLOCKWISE_SEATS = [1, 8, 7, 6, 5, 4, 3, 2];  // Seat 9 removed
        
        const assignments = [];
        
        // Assign hero to seat 1, then assign others clockwise following game.order
        if (heroIncluded) {
            assignments.push({ pid: heroId, seat: 1 });
            
            // Get hero's index in game order
            const heroIndex = seats.indexOf(heroId);
            
            // Players after hero in game order (clockwise from hero's perspective)
            const playersAfterHero = seats.slice(heroIndex + 1);
            const playersBeforeHero = seats.slice(0, heroIndex);
            const otherPlayersInOrder = [...playersAfterHero, ...playersBeforeHero];
            
            // Assign other players to clockwise seats (8, 7, 6, 5, 4, 3, 2)
            otherPlayersInOrder.forEach((pid, idx) => {
                if (idx + 1 < CLOCKWISE_SEATS.length) {
                    assignments.push({ pid, seat: CLOCKWISE_SEATS[idx + 1] });
                }
            });
        } else {
            // No hero, just assign in order
            seats.forEach((pid, idx) => {
                if (idx < CLOCKWISE_SEATS.length) {
                    assignments.push({ pid, seat: CLOCKWISE_SEATS[idx] });
                }
            });
        }

        if (!assignments.length) {
            currentGame.bets = {};
            return;
        }

        const newBetCache = {};
        assignments.forEach(({ pid, seat }) => {
            const player = state.players[pid];
            const entry = seatEntries.get(seat);
            if (!player || !entry) return;

            const meta = SEAT_META[seat] || { cardsRight: false };
            const isHero = pid === heroId;
            const isTurn = pid === state.turn;
            const summary = showdownHands[pid];
            const isWinner = showdownWinnersSet.has(pid) && isShowdownPhase;
            const revealShowdown = isShowdownPhase && player.inHand && !player.folded;
            const bestCardSet = new Set(Array.isArray(summary?.bestCards) ? summary.bestCards.map(toCardKey) : []);
            const showHole = isHero || revealShowdown;

            entry.root.classList.remove('is-empty');
            entry.root.classList.add('occupied');
            entry.root.dataset.player = pid;
            entry.root.classList.toggle('is-hero', isHero);
            entry.root.classList.toggle('opponent', !isHero);
            entry.root.classList.toggle('is-active-turn', isTurn);
            entry.root.classList.toggle('is-folded', !!player.folded);
            entry.root.classList.toggle('is-out', !player.inHand);
            entry.root.classList.toggle('is-bot', !!player.bot);
            entry.root.classList.toggle('is-winner', isWinner);
            entry.root.classList.toggle('showdown-reveal', revealShowdown);
            if (meta.cardsRight) {
                entry.root.classList.add('cards-right');
            } else {
                entry.root.classList.remove('cards-right');
            }

            if (entry.name) {
                const baseName = player.name || 'Player';
                entry.name.textContent = player.bot ? `${baseName} 🤖` : baseName;
            }
            if (entry.stack) {
                entry.stack.textContent = formatNumber(player.stack || 0, { fractionDigits: 0 });
            }

            const holeCards = Array.isArray(player.hole) ? player.hole : [];
            const size = isHero ? 'hero' : 'small';
            let cardsHtml = '';
            if (holeCards.length) {
                cardsHtml = holeCards.map((card) => {
                    const cardKey = toCardKey(card);
                    const shouldHighlight = showHole && bestCardSet.has(cardKey);
                    return renderCardHtml(card, showHole, size, { highlight: shouldHighlight });
                }).join('');
            }
            if (!cardsHtml) {
                cardsHtml = `${renderCardHtml('??', false, size)}${renderCardHtml('??', false, size)}`;
            }
            if (entry.cards) entry.cards.innerHTML = cardsHtml;

            const tags = [];
            if (pid === state.smallBlind) tags.push('<span class="player-badge badge-sb">SB</span>');
            if (pid === state.bigBlind) tags.push('<span class="player-badge badge-bb">BB</span>');
            updateSeatTags(entry, tags);

            const betAmount = Math.max(0, player.bet || 0);
            newBetCache[pid] = betAmount;
            if (entry.bet) {
                if (betAmount > 0) {
                    entry.bet.dataset.amount = String(betAmount);
                    entry.bet.innerHTML = `<span class="bet-chip">${formatNumber(betAmount, { fractionDigits: 0 })}</span>`;
                    entry.root.classList.add('has-bet');
                } else {
                    entry.bet.dataset.amount = '0';
                    entry.bet.innerHTML = '';
                    entry.root.classList.remove('has-bet');
                }
            }

            const isDealer = pid === state.dealer;
            entry.root.classList.toggle('has-dealer', isDealer);
            if (entry.dealer) {
                entry.dealer.setAttribute('aria-hidden', isDealer ? 'false' : 'true');
            }
        });

        currentGame.bets = newBetCache;

        if (potContainerEl) {
            const potRect = potContainerEl.getBoundingClientRect();
            previousBetRects.forEach(({ rect, amount }, pid) => {
                const next = newBetCache[pid] || 0;
                if (amount > 0 && next === 0) {
                    animateBetToPot(rect, amount, potRect);
                }
            });
        }
    }

    function clearPotPulse() {
        if (potHeatTimer) {
            clearTimeout(potHeatTimer);
            potHeatTimer = null;
        }
        if (potContainerEl) {
            potContainerEl.classList.remove('is-hot');
        }
    }

    function triggerPotPulse(duration = 2200) {
        if (!potContainerEl) return;
        potContainerEl.classList.add('is-hot');
        if (potHeatTimer) clearTimeout(potHeatTimer);
        potHeatTimer = window.setTimeout(() => {
            if (potContainerEl) {
                potContainerEl.classList.remove('is-hot');
            }
            potHeatTimer = null;
        }, Math.max(0, duration));
    }

    function animateBetToPot(sourceRect, amount, potRect) {
        if (!sourceRect || !potRect || !(amount > 0)) return;
        if (!document.body) return;
        const sourceCenterX = sourceRect.left + (sourceRect.width / 2);
        const sourceCenterY = sourceRect.top + (sourceRect.height / 2);
        const targetCenterX = potRect.left + (potRect.width / 2);
        const targetCenterY = potRect.top + (potRect.height / 2);
        if (!Number.isFinite(sourceCenterX) || !Number.isFinite(sourceCenterY)) return;
        if (!Number.isFinite(targetCenterX) || !Number.isFinite(targetCenterY)) return;

        const flyChip = document.createElement('div');
        flyChip.className = 'bet-chip fly';
        flyChip.innerHTML = `<div class="amt">${formatNumber(amount, { fractionDigits: 0 })}</div>`;
        flyChip.style.left = `${sourceCenterX}px`;
        flyChip.style.top = `${sourceCenterY}px`;
        document.body.appendChild(flyChip);
        triggerPotPulse();

        requestAnimationFrame(() => {
            flyChip.style.left = `${targetCenterX}px`;
            flyChip.style.top = `${targetCenterY}px`;
            flyChip.classList.add('arrive');
        });

        const cleanup = () => {
            flyChip.removeEventListener('transitionend', cleanup);
            if (flyChip.parentNode) {
                flyChip.parentNode.removeChild(flyChip);
            }
        };
        flyChip.addEventListener('transitionend', cleanup);
        setTimeout(cleanup, 720);
    }
    function ensureProfilePopup() {
        if (profilePopup) return profilePopup;
        profilePopup = document.createElement('div');
        profilePopup.className = 'profile-popup';
        profilePopup.innerHTML = `
            <div class="profile-popup-section">
                <div class="profile-popup-title">Balances</div>
                <div class="profile-popup-balance"><span>WBSTR</span><span id="pp-wbstr">-</span></div>
            </div>
            <div class="profile-popup-section">
                <div class="profile-popup-title">Rewards</div>
                <div class="profile-popup-actions">
                    <button id="btn-claim-rewards" class="profile-action-btn" type="button">Claim LYX</button>
                    <button id="btn-claim-all" class="profile-action-btn primary" type="button">Claim all</button>
                </div>
                <div id="profile-claim-status" class="profile-claim-status"></div>
            </div>
        `;
        document.body.appendChild(profilePopup);
        profilePopup.style.display = 'none';

        const claimRewardsBtn = profilePopup.querySelector('#btn-claim-rewards');
        const claimAllBtn = profilePopup.querySelector('#btn-claim-all');
        profilePopupWbstrEl = profilePopup.querySelector('#pp-wbstr');
        claimStatusEl = profilePopup.querySelector('#profile-claim-status');
        claimAllButtonPopup = claimAllBtn;
        claimRewardsButtonPopup = claimRewardsBtn;

        if (claimAllBtn) {
            claimAllBtn.style.display = 'none';
            claimAllBtn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                await handleClaimAll({ source: 'profile' });
            });
        }
        if (claimRewardsBtn) {
            claimRewardsBtn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                await handleClaimRewards({ source: 'profile' });
            });
        }
        return profilePopup;
    }
    async function refreshProfilePopup({ forceClaimSummary = false } = {}) {
        try {
            ensureProfilePopup();
            if (!window.__upAddress) return;
            const [balances, summary] = await Promise.all([
                getBalances(window.__upAddress),
                getClaimSummary(window.__upAddress, { force: forceClaimSummary })
            ]);
            const decimals = Math.max(0, balances?.wbstrDecimals ?? 18);
            const wbstrAmount = balances?.wbstr ?? 0n;
            if (profilePopupWbstrEl) {
                const formatted = formatTokenAmount(wbstrAmount, { decimals, fractionDigits: 3 });
                profilePopupWbstrEl.textContent = `${formatted} ${TOKEN_SYMBOL}`;
            }
            await updateClaimButtonStates();
        } catch (e) {
            if (profilePopupWbstrEl) profilePopupWbstrEl.textContent = '—';
        }
    }
    function toggleProfilePopup() {
        ensureProfilePopup();
        if (profilePopup.style.display === 'none') {
            profilePopup.style.display = 'block';
            refreshProfilePopup({ forceClaimSummary: true });
        } else {
            profilePopup.style.display = 'none';
        }
    }
    const shortenAddress = (addr) => {
        if (!addr || typeof addr !== 'string') return '';
        const trimmed = addr.trim();
        if (trimmed.length <= 10) return trimmed;
        const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
        return `${prefixed.slice(0, 6)}…${prefixed.slice(-4)}`;
    };
    const shortenTxHash = (hash) => {
        if (!hash || typeof hash !== 'string') return '';
        const trimmed = hash.trim();
        if (!trimmed || trimmed.length <= 12) return trimmed;
        return `${trimmed.slice(0, 10)}…${trimmed.slice(-6)}`;
    };
    const sanitizeImageUrl = (url) => {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        return null;
    };

    const resolveAssetUrl = (url) => {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('ipfs://')) {
            return `${IPFS_GATEWAY}${trimmed.slice(7)}`;
        }
        return trimmed;
    };

    const getMetadataProvider = () => {
        if (typeof window !== 'undefined' && (window.lukso || window.ethereum)) {
            return window.lukso || window.ethereum;
        }
        if (!fallbackMetadataProvider) {
            try {
                fallbackMetadataProvider = new ethers.JsonRpcProvider(FALLBACK_RPC_URL);
            } catch (err) {
                console.warn('Failed to initialise fallback RPC provider', err);
                fallbackMetadataProvider = null;
            }
        }
        return fallbackMetadataProvider;
    };

    async function fetchTokenMetadata(tokenAddress) {
        if (!tokenAddress) return null;
        let checksum;
        try {
            checksum = ethers.getAddress(tokenAddress);
        } catch (_) {
            return null;
        }
        const key = checksum.toLowerCase();
        if (tokenMetadataCache.has(key)) {
            return tokenMetadataCache.get(key);
        }
        const provider = getMetadataProvider();
        if (!provider) {
            const fallback = { name: TOKEN_SYMBOL, symbol: TOKEN_SYMBOL, description: '', icon: null };
            tokenMetadataCache.set(key, fallback);
            return fallback;
        }
        try {
            const erc725Config = { ipfsGateway: IPFS_GATEWAY };
            const erc725 = new ERC725(LSP4_SCHEMA, checksum, provider, erc725Config);
            const [tokenName, tokenSymbol, metadataLink] = await Promise.all([
                erc725.fetchData('LSP4TokenName').catch(() => null),
                erc725.fetchData('LSP4TokenSymbol').catch(() => null),
                erc725.fetchData('LSP4Metadata').catch(() => null)
            ]);

            let name = (Array.isArray(tokenName) ? tokenName[0]?.value : tokenName?.value) || `${TOKEN_SYMBOL} Token`;
            let symbol = (Array.isArray(tokenSymbol) ? tokenSymbol[0]?.value : tokenSymbol?.value) || TOKEN_SYMBOL;
            let description = '';
            let iconUrl = null;

            const metadataValue = Array.isArray(metadataLink) ? metadataLink[0]?.value : metadataLink?.value;
            const metadataUrl = resolveAssetUrl(
                typeof metadataValue === 'string'
                    ? metadataValue
                    : metadataValue?.url || metadataValue?.link || metadataValue?.href || metadataValue?.uri || null
            );
            if (metadataUrl) {
                try {
                    const response = await fetch(metadataUrl, { cache: 'no-store' });
                    if (response.ok) {
                        const metadataJson = await response.json();
                        description = metadataJson?.description || '';
                        name = metadataJson?.name || name;
                        symbol = metadataJson?.symbol || symbol;
                        const iconCandidates = Array.isArray(metadataJson?.icon) ? metadataJson.icon : [];
                        const imageCandidates = Array.isArray(metadataJson?.images) ? metadataJson.images.flat() : [];
                        const combined = [...iconCandidates, ...imageCandidates];
                        const imageObj = combined.find((item) => item && (item.url || item.link || item.href));
                        iconUrl = sanitizeImageUrl(resolveAssetUrl(imageObj?.url || imageObj?.link || imageObj?.href || null));
                    }
                } catch (metaErr) {
                    console.warn('Token metadata JSON fetch failed', metadataUrl, metaErr);
                }
            }

            const metadata = {
                name: name || `${TOKEN_SYMBOL} Token`,
                symbol: symbol || TOKEN_SYMBOL,
                description: description || '',
                icon: iconUrl || null
            };
            tokenMetadataCache.set(key, metadata);
            return metadata;
        } catch (err) {
            console.warn('Token metadata fetch failed', tokenAddress, err);
            const fallback = { name: `${TOKEN_SYMBOL} Token`, symbol: TOKEN_SYMBOL, description: '', icon: null };
            tokenMetadataCache.set(key, fallback);
            return fallback;
        }
    }

    async function getClaimSummary(address, { force = false } = {}) {
        if (!address) {
            return { address: null, entries: [], count: 0, hasClaimable: false, timestamp: Date.now() };
        }
        let checksum;
        try {
            checksum = ethers.getAddress(address);
        } catch (_) {
            checksum = address;
        }
        const cacheHit = latestClaimSummary.address && latestClaimSummary.address.toLowerCase() === checksum.toLowerCase();
        if (!force && cacheHit && (Date.now() - latestClaimSummary.timestamp) < 15000) {
            return latestClaimSummary;
        }
        const tokens = Array.from(new Set(getDefaultPrizeTokens() || []));
        const entries = [];
        for (const token of tokens) {
            try {
                const payout = await getAuthorizedPayout(token, checksum);
                if (payout && payout > 0n) {
                    entries.push({ token, amount: payout });
                }
            } catch (err) {
                console.warn('getAuthorizedPayout failed', token, err);
            }
        }
        latestClaimSummary = {
            address: checksum,
            entries,
            count: entries.length,
            hasClaimable: entries.length > 0,
            timestamp: Date.now()
        };
        return latestClaimSummary;
    }

    async function updateClaimButtonStates() {
        // NEW SYSTEM: Check GameVault balances for player's tables
        const address = window.__upAddress;
        if (!address) {
            // Not logged in - hide/disable claim buttons
            if (menuClaimBtn) {
                menuClaimBtn.style.display = 'none';
            }
            if (inlineClaimBtn) {
                inlineClaimBtn.style.display = 'none';
            }
            if (menuClaimNote) {
                menuClaimNote.textContent = '';
            }
            if (claimAllButtonPopup) {
                claimAllButtonPopup.style.display = 'none';
            }
            return;
        }

        try {
            // Get tables where player deposited
            const tableIds = getPlayerTableIds(address);
            const token = WBSTR_TOKEN_ADDRESS || ZERO_ADDRESS;
            let totalBalance = 0n;
            let tablesWithBalance = 0;

            for (const tableInfo of tableIds) {
                try {
                    // Check if table is actually ended before checking balance
                    const tableDoc = await db.collection('tables').doc(tableInfo.firestoreId).get();
                    const tableData = tableDoc.exists ? tableDoc.data() : null;
                    
                    // Only count as claimable if table status is 'ended'
                    if (tableData && tableData.status === 'ended') {
                        const balance = await getVaultBalance(tableInfo.onchainId, address, token);
                        if (balance > 0n) {
                            totalBalance += balance;
                            tablesWithBalance++;
                        }
                    }
                } catch (err) {
                    // Skip tables that error
                }
            }

            const hasClaimable = totalBalance > 0n;
            const count = tablesWithBalance;

            // Update UI
            if (menuClaimBtn) {
                menuClaimBtn.style.display = 'inline-flex';
                menuClaimBtn.disabled = false;
                menuClaimBtn.textContent = hasClaimable 
                    ? (count === 1 ? '💰 Claim Winnings' : `💰 Claim Winnings (${count})`)
                    : '💰 Claim Winnings';
            }
            if (inlineClaimBtn) {
                inlineClaimBtn.style.display = 'inline-flex';
                inlineClaimBtn.disabled = false;
                const label = hasClaimable
                    ? (count === 1 ? 'Claim reward' : `Claim rewards (${count})`)
                    : 'Claim';
                inlineClaimBtn.textContent = label;
                inlineClaimBtn.title = hasClaimable ? 'Claim your pending rewards' : 'Check if you have rewards to claim';
                inlineClaimBtn.classList.toggle('primary', hasClaimable);
                inlineClaimBtn.classList.toggle('secondary', !hasClaimable);
            }
            if (menuClaimNote) {
                menuClaimNote.textContent = hasClaimable
                    ? `You have ${count} reward${count === 1 ? '' : 's'} ready.`
                    : `Play matches to unlock ${TOKEN_SYMBOL} rewards.`;
            }
            if (claimAllButtonPopup) {
                claimAllButtonPopup.style.display = hasClaimable ? 'inline-flex' : 'none';
                claimAllButtonPopup.disabled = !hasClaimable;
            }
        } catch (err) {
            console.warn('Failed to update claim button states:', err);
            // On error, show button but don't claim it has rewards
            if (menuClaimBtn) {
                menuClaimBtn.style.display = 'inline-flex';
                menuClaimBtn.disabled = false;
                menuClaimBtn.textContent = '💰 Claim Winnings';
            }
            if (menuClaimNote) {
                menuClaimNote.textContent = 'Click to check for rewards.';
            }
        }
    }

    async function refreshWbstrSummary({ force = false } = {}) {
        if (!menuTokenCard) return;
        const address = window.__upAddress;
        if (!address) {
            menuTokenCard.style.display = 'none';
            if (menuClaimNote) menuClaimNote.textContent = `Connect a profile to view ${TOKEN_SYMBOL} balance.`;
            await updateClaimButtonStates();
            clearInlineClaimFeedback();
            return;
        }
        menuTokenCard.style.display = '';
        if (menuTokenBalanceEl) menuTokenBalanceEl.textContent = 'Checking…';
        if (menuTokenChipsEl) menuTokenChipsEl.textContent = '—';
        if (menuTokenAddressEl) menuTokenAddressEl.textContent = shortenAddress(WBSTR_TOKEN_ADDRESS);
        try {
            const [balances, summary, metadata] = await Promise.all([
                getBalances(address),
                getClaimSummary(address, { force }),
                fetchTokenMetadata(WBSTR_TOKEN_ADDRESS)
            ]);

            const decimals = Math.max(0, balances?.wbstrDecimals ?? 18);
            const wbstrAmount = balances?.wbstr ?? 0n;
            const formattedWbstr = formatTokenAmount(wbstrAmount, { decimals, fractionDigits: 3 });
            
            // Update global TOKEN_SYMBOL from metadata
            if (metadata && metadata.symbol) {
                TOKEN_SYMBOL = metadata.symbol;
            }
            
            if (menuTokenBalanceEl) menuTokenBalanceEl.textContent = `${formattedWbstr} ${TOKEN_SYMBOL}`;

            let chipsLabel = '—';
            try {
                const wbstrUnits = Number(ethers.formatUnits(wbstrAmount, decimals));
                const chipEquivalent = wbstrUnits / WBSTR_PER_CHIP;
                if (Number.isFinite(chipEquivalent)) {
                    chipsLabel = `${formatNumber(chipEquivalent, { fractionDigits: 2 })} chips`;
                }
            } catch (_) {
                chipsLabel = '—';
            }
            if (menuTokenChipsEl) menuTokenChipsEl.textContent = chipsLabel;

            if (metadata) {
                if (menuTokenNameEl) menuTokenNameEl.textContent = metadata.name || `${TOKEN_SYMBOL} Token`;
                if (menuTokenSymbolEl) {
                    const symbol = metadata.symbol || TOKEN_SYMBOL;
                    menuTokenSymbolEl.textContent = `${symbol} • LSP7`;
                }
                if (menuTokenFallback) {
                    if (metadata.icon) {
                        menuTokenFallback.style.display = 'none';
                    } else {
                        menuTokenFallback.style.display = 'grid';
                        menuTokenFallback.textContent = (metadata.symbol || TOKEN_SYMBOL).slice(0, 6).toUpperCase();
                    }
                }
                if (menuTokenIcon) {
                    // Always use WBSTR logo from local file
                    menuTokenIcon.src = '/wbstr.jpg';
                    menuTokenIcon.style.display = 'block';
                }
            } else {
                if (menuTokenNameEl) menuTokenNameEl.textContent = 'WokeBuster';
                if (menuTokenSymbolEl) menuTokenSymbolEl.textContent = 'WBSTR • LSP7';
                if (menuTokenFallback) {
                    menuTokenFallback.style.display = 'none'; // Hide fallback text
                }
                if (menuTokenIcon) {
                    // Use WBSTR logo from local file
                    menuTokenIcon.src = '/wbstr.jpg';
                    menuTokenIcon.style.display = 'block';
                }
            }

            await updateClaimButtonStates();
        } catch (err) {
            console.warn('Failed to refresh WBSTR summary', err);
            if (menuTokenBalanceEl) menuTokenBalanceEl.textContent = 'Unable to load';
            if (menuTokenChipsEl) menuTokenChipsEl.textContent = '—';
            if (menuClaimNote) menuClaimNote.textContent = 'Unable to fetch rewards. Try again later.';
            await updateClaimButtonStates();
        }
    }
    function resetAccountPicker() {
        selectedAccount = null;
        accountOptions = [];
        if (accountsListEl) accountsListEl.innerHTML = '';
        if (accountContinueBtn) {
            accountContinueBtn.disabled = true;
            accountContinueBtn.textContent = 'Continue';
        }
        if (accountsLoadingEl) {
            accountsLoadingEl.style.display = 'none';
            accountsLoadingEl.textContent = 'Requesting wallet access…';
        }
    }
    function setAccountSelection(address) {
        if (!address) {
            selectedAccount = null;
            if (accountContinueBtn) accountContinueBtn.disabled = true;
            return;
        }
        const target = address.toLowerCase();
        selectedAccount = accountOptions.find((opt) => opt.address.toLowerCase() === target) || null;
        if (accountsListEl) {
            accountsListEl.querySelectorAll('.account-card').forEach((card) => {
                const cardAddr = (card.dataset?.address || '').toLowerCase();
                card.classList.toggle('selected', cardAddr === target);
            });
        }
        if (accountContinueBtn) accountContinueBtn.disabled = !selectedAccount;
        if (selectedAccount && errorMessage) errorMessage.textContent = '';
    }
    function renderAccountOptions(options, { preselect } = {}) {
        if (!accountsListEl) return;
        accountsListEl.innerHTML = '';
        if (!Array.isArray(options) || !options.length) {
            if (accountsLoadingEl) {
                accountsLoadingEl.style.display = 'block';
                accountsLoadingEl.textContent = 'No accounts detected. Unlock your Universal Profile extension and try again.';
            }
            if (accountPickerHint) {
                accountPickerHint.textContent = 'No Universal Profiles are available. Unlock your wallet and click “Sign in with Universal Profile”.';
            }
            return;
        }
        if (accountsLoadingEl) accountsLoadingEl.style.display = 'none';
        const hasEoa = options.some((opt) => !opt.isUp);
        if (accountPickerHint) {
            accountPickerHint.textContent = hasEoa
                ? 'Select the Universal Profile you want to use. EOA accounts typically cannot interact with the Key Manager.'
                : 'Select the Universal Profile you want to use. We recommend choosing the profile that holds your WBSTR chips.';
        }
        options.forEach((account) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'account-card';
            card.dataset.address = account.address;

            const avatar = document.createElement('div');
            avatar.className = 'account-avatar';
            const avatarUrl = sanitizeImageUrl(account.avatar);
            if (avatarUrl) {
                const img = document.createElement('img');
                img.src = avatarUrl;
                img.alt = '';
                avatar.appendChild(img);
            } else {
                const initial = (account.name || account.address || '?').trim().charAt(0) || '?';
                avatar.textContent = initial.toUpperCase();
            }

            const meta = document.createElement('div');
            meta.className = 'account-meta';
            const nameEl = document.createElement('div');
            nameEl.className = 'account-name';
            nameEl.textContent = account.name || shortenAddress(account.address);
            const typeEl = document.createElement('div');
            typeEl.className = 'account-type';
            typeEl.textContent = account.isUp ? 'Universal Profile' : 'Externally Owned Account';
            const addrEl = document.createElement('div');
            addrEl.className = 'account-address';
            addrEl.textContent = shortenAddress(account.address);
            meta.appendChild(nameEl);
            meta.appendChild(typeEl);
            meta.appendChild(addrEl);

            card.appendChild(avatar);
            card.appendChild(meta);
            card.addEventListener('click', () => {
                setAccountSelection(account.address);
                if (accountOptions.length === 1 && accountContinueBtn && !accountContinueBtn.disabled) {
                    accountContinueBtn.click();
                }
            });
            accountsListEl.appendChild(card);
        });
        if (preselect) {
            const normalized = preselect.toLowerCase();
            if (accountOptions.some((opt) => opt.address.toLowerCase() === normalized)) {
                setAccountSelection(preselect);
            }
        }
    }
    async function loadAvailableAccounts({ requestPermission = false } = {}) {
        const raw = window.lukso || window.ethereum;
        if (!raw) {
            throw new Error('No LUKSO provider found. Install the Universal Profile browser extension.');
        }
        const provider = new ethers.BrowserProvider(raw);
        let addresses = [];
        if (requestPermission) {
            try {
                addresses = await raw.request({ method: 'eth_requestAccounts' });
            } catch (e) {
                const message = e?.message || e?.reason || '';
                const lowered = String(message).toLowerCase();
                if (e?.code === 4001 || lowered.includes('denied') || lowered.includes('rejected')) {
                    throw new Error('Wallet connection was cancelled. Please approve the request to continue.');
                }
                throw new Error(message || 'Unable to access accounts.');
            }
        } else {
            try {
                addresses = await provider.send('eth_accounts', []);
            } catch (_) {
                addresses = [];
            }
        }
        if (!Array.isArray(addresses)) addresses = [];
        const normalized = [...new Set(addresses.map((addr) => {
            try { return ethers.getAddress(addr); } catch (_) { return null; }
        }).filter(Boolean).map((addr) => addr.toLowerCase()))];
        if (!normalized.length) return [];

        const details = [];
        for (const lower of normalized) {
            const address = ethers.getAddress(lower);
            try {
                const code = await provider.getCode(address);
                const isUp = code && code !== '0x';
                let name = isUp ? await fetchProfileName(address) : null;
                if (!name && cachedPreferredAddress && cachedPreferredAddress.toLowerCase() === lower && cachedPreferredName) {
                    name = cachedPreferredName;
                }
                const avatar = isUp ? await fetchAvatarForAddress(address) : null;
                const fallbackName = name || shortenAddress(address);
                details.push({
                    address,
                    name: name || fallbackName,
                    avatar,
                    isUp,
                });
            } catch (_) {
                const fallbackName = shortenAddress(address);
                details.push({ address, name: fallbackName, avatar: null, isUp: false });
            }
        }
        return details;
    }
    
    /**
     * Auto-reconnect: Try to restore the active game from localStorage
     * @param {boolean} showMenuOnFail - If true, show menu if reconnect fails
     */
    async function tryAutoReconnect(showMenuOnFail = true) {
        try {
            const savedGame = localStorage.getItem('activeGame');
            if (!savedGame) {
                if (showMenuOnFail) showMainMenu();
                return;
            }
            
            const gameData = JSON.parse(savedGame);
            const age = Date.now() - (gameData.timestamp || 0);
            
            // Check game age (30 minutes)
            if (age >= 30 * 60 * 1000) {
                console.log('Saved game is too old, clearing...');
                localStorage.removeItem('activeGame');
                if (showMenuOnFail) showMainMenu();
                return;
            }
            
            // Check if we have all the necessary data
            if (!gameData.tableId) {
                console.warn('Saved game missing tableId, clearing...');
                localStorage.removeItem('activeGame');
                if (showMenuOnFail) showMainMenu();
                return;
            }
            
            // Check if table still exists
            setMessage('Checking your previous game...');
            const tableDoc = await getTable(gameData.tableId);
            
            if (!tableDoc) {
                console.log('Previous game no longer exists, clearing...');
                localStorage.removeItem('activeGame');
                if (showMenuOnFail) showMainMenu();
                return;
            }
            
            // Check table status
            const status = (tableDoc.status || '').toLowerCase();
            if (status === 'finished' || status === 'cancelled') {
                console.log('Previous game is finished, clearing...');
                localStorage.removeItem('activeGame');
                if (showMenuOnFail) showMainMenu();
                return;
            }
            
            // If AI table, check aiMatchResult
            if (gameData.isAiTable) {
                const result = tableDoc.aiMatchResult;
                if (result) {
                    const statusRaw = typeof result === 'string' ? result : (result.status || result.outcome);
                    const resultStatus = String(statusRaw || '').toLowerCase();
                    if (resultStatus === 'humanwon' || resultStatus === 'humanlost') {
                        console.log('AI game already has result, clearing...');
                        localStorage.removeItem('activeGame');
                        if (showMenuOnFail) showMainMenu();
                        return;
                    }
                }
            }
            
            // Everything OK, restore the game!
            console.log('Auto-reconnecting to game:', gameData.tableId);
            setMessage('Restoring your previous game...');
            
            // Wait a bit for everything to load
            setTimeout(() => {
                enterGame(gameData.tableId, gameData.myDocId, { isAi: gameData.isAiTable });
            }, 500);
            
        } catch (e) {
            console.error('Auto-reconnect failed:', e);
            localStorage.removeItem('activeGame');
            if (showMenuOnFail) showMainMenu();
        }
    }
    
    async function completeLogin(account) {
        if (!account) throw new Error('Please select an account to continue.');
        const raw = window.lukso || window.ethereum;
        if (!raw) throw new Error('No LUKSO provider found. Install the Universal Profile browser extension.');
        const provider = new ethers.BrowserProvider(raw);
        const signer = await provider.getSigner();
        let activeAddress = await signer.getAddress();
        try { activeAddress = ethers.getAddress(activeAddress); } catch (_) { /* ignore */ }
        const target = ethers.getAddress(account.address);
        if (activeAddress.toLowerCase() !== target.toLowerCase()) {
            throw new Error('Please switch to the selected profile in your Universal Profile extension, then press Continue again.');
        }

        window.__upAddress = target;
        window.__upUsername = account.name || shortenAddress(target);
        try {
            localStorage.setItem('up.address', window.__upAddress);
            localStorage.setItem('up.username', window.__upUsername);
        } catch (_) {}

        if (errorMessage) errorMessage.textContent = '';
        if (profileDisplay) profileDisplay.style.display = 'flex';
        if (profileName) profileName.textContent = window.__upUsername;
        if (profileAddressElem) profileAddressElem.textContent = target;
        if (profileImage) {
            const avatarUrl = sanitizeImageUrl(account.avatar);
            if (avatarUrl) {
                profileImage.src = avatarUrl;
                profileImage.style.display = 'inline-block';
            } else {
                profileImage.removeAttribute('src');
                profileImage.style.display = 'none';
            }
        }
        if (connectButton) connectButton.style.display = 'none';
        if (accountPicker) accountPicker.style.display = 'none';
        if (toggleProfileBtn) toggleProfileBtn.style.display = 'inline-block';
        if (logoutBtn) logoutBtn.style.display = 'inline-block';
        if (authContainer) authContainer.style.display = 'none';
        if (postLoginMenu) postLoginMenu.style.display = 'flex';
        try {
            await Promise.all([
                refreshWbstrSummary({ force: true }),
                refreshProfilePopup({ forceClaimSummary: true })
            ]);
        } catch (_) {}
        
        // Auto-reconnect: Poskusi obnoviti aktivno igro iz localStorage
        await tryAutoReconnect(true);
    }
    async function displayAccountPicker({ requestPermission = false } = {}) {
        if (!accountPicker) return;
        if (authContainer) authContainer.style.display = 'flex';
        accountPicker.style.display = 'flex';
        resetAccountPicker();
        if (accountsLoadingEl) {
            accountsLoadingEl.style.display = 'block';
            accountsLoadingEl.textContent = requestPermission ? 'Requesting wallet access…' : 'Loading accounts…';
        }
        try {
            const accounts = await loadAvailableAccounts({ requestPermission });
            accountOptions = accounts;
            renderAccountOptions(accountOptions, { preselect: cachedPreferredAddress });
            if (accountOptions.length === 1) {
                setAccountSelection(accountOptions[0].address);
            }
            if (accountOptions.length && connectButton) {
                connectButton.textContent = 'Refresh account list';
            }
        } catch (err) {
            if (accountsLoadingEl) accountsLoadingEl.style.display = 'none';
            if (errorMessage) errorMessage.textContent = err?.message || 'Unable to load accounts. Please try again.';
            if (!accountOptions.length && accountPicker) {
                accountPicker.style.display = 'none';
            }
        }
    }
    // Post-login menu elements
    const postLoginMenu = document.getElementById('postlogin-menu');
    const backToMenuBtn = document.getElementById('btn-back-menu');
    const logoutBtn = document.getElementById('btn-logout');
    const panelJoin = document.getElementById('panel-join');
    const panelWaiting = document.getElementById('panel-waiting');
    const panelAI = document.getElementById('panel-ai');
    const aiDifficultyEl = document.getElementById('ai-difficulty');
    const aiStackEl = document.getElementById('ai-stack');
    const aiPotentialRewardEl = document.getElementById('ai-potential-reward');
    const panelBoards = document.getElementById('panel-boards');
    const panelHelp = document.getElementById('panel-help');
    // Firebase-related UI elements
    const createTableResult = document.getElementById('create-table-result');
    const joinTableIdInput = document.getElementById('join-table-id');
    const joinTableBtn = document.getElementById('btn-join-table');
    const refreshTablesBtn = document.getElementById('btn-refresh-tables');
    const publicTablesEl = document.getElementById('public-tables');
    // Deposit UI (Join panel)
    const depositRow = document.getElementById('deposit-row');
    const depositInput = document.getElementById('deposit-amount');
    const depositBtn = document.getElementById('btn-deposit');
    const depositResult = document.getElementById('deposit-result');
    // Leaderboard UI
    const refreshBoardsBtn = document.getElementById('btn-refresh-boards');
    const boardCategorySelect = document.getElementById('board-category');
    const leaderboardLoading = document.getElementById('leaderboard-loading');
    const leaderboardList = document.getElementById('leaderboard-list');
    const leaderboardEmpty = document.getElementById('leaderboard-empty');
    // Waiting room UI
    const waitingTableTitleEl = document.getElementById('waiting-table-title');
    const waitingTableMetaEl = document.getElementById('waiting-table-meta');
    const waitingPlayersEl = document.getElementById('waiting-players');
    const waitingChatEl = document.getElementById('waiting-chat');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('btn-chat-send');
    const startTableBtn = document.getElementById('btn-start-table');
    const leaveWaitingBtn = document.getElementById('btn-leave-waiting');
    
    // Avatar cache for waiting-room (address -> avatar URL|null)
    const avatarCache = new Map();
    const profileNameCache = new Map();
    // --- IMPROVED ---: Simplified logic for finding image URL
    async function fetchAvatarForAddress(address) {
        if (!address) return null;
        if (avatarCache.has(address)) return avatarCache.get(address);
        try {
            const web3Provider = window.lukso || window.ethereum;
            const erc725Config = { ipfsGateway: 'https://api.universalprofile.cloud/ipfs/' };
            const erc725 = new ERC725(LSP3ProfileSchema, address, web3Provider, erc725Config);
            const profileDataResult = await erc725.fetchData('LSP3Profile');
            const profileData = (Array.isArray(profileDataResult) ? profileDataResult[0] : profileDataResult)?.value?.LSP3Profile;
            const maybeName = profileData?.name || null;
            if (!profileNameCache.has(address)) {
                profileNameCache.set(address, maybeName);
            }
            
            let img = null;
            if (profileData) {
                // Let's try to find the image in different possible fields
                const potentialImages = [
                    ...(profileData.profileImage || []),
                    ...(profileData.image || []),
                    ...(profileData.links || [])
                ];
                const imageObject = potentialImages.find(item => item && (item.url || item.link || item.href));
                if (imageObject) {
                    img = imageObject.url || imageObject.link || imageObject.href;
                }
            }

            if (img && typeof img === 'string' && img.startsWith('ipfs://')) {
                img = erc725Config.ipfsGateway + img.replace('ipfs://', '');
            }
            
            avatarCache.set(address, img || null);
            return img || null;
        } catch (e) {
            if (!profileNameCache.has(address)) {
                profileNameCache.set(address, null);
            }
            avatarCache.set(address, null);
            return null;
        }
    }

    async function fetchProfileName(address) {
        if (!address) return null;
        if (profileNameCache.has(address)) return profileNameCache.get(address);
        try {
            const web3Provider = window.lukso || window.ethereum;
            const erc725Config = { ipfsGateway: 'https://api.universalprofile.cloud/ipfs/' };
            const erc725 = new ERC725(LSP3ProfileSchema, address, web3Provider, erc725Config);
            const profileDataResult = await erc725.fetchData('LSP3Profile');
            const profileData = (Array.isArray(profileDataResult) ? profileDataResult[0] : profileDataResult)?.value?.LSP3Profile;
            const name = profileData?.name || null;
            profileNameCache.set(address, name);
            return name;
        } catch (_) {
            profileNameCache.set(address, null);
            return null;
        }
    }

    // Setup validation
    const validateSetupForm = () => {
        const createTableBtn = document.getElementById('btn-create-table');
        if (!createTableBtn) return;

        const isNameValid = setupName && setupName.value.trim().length >= 3;
        const isPlayersValid = setupPlayers && setupPlayers.value.trim() !== '';
        const isStackValid = setupStack && setupStack.value.trim() !== '';
        const isSbValid = setupSB && setupSB.value.trim() !== '';
        const isBbValid = setupBB && setupBB.value.trim() !== '';
        const isTokenValid = setupToken && setupToken.value.trim() !== '';
        const isBuyinValid = setupBuyin && setupBuyin.value.trim() !== '';
        const isMinChipsValid = setupMinChips && setupMinChips.value.trim() !== '';
        // Scheduled requires exact date & time in the future
        let scheduledOk = true;
        const typeVal = (setupGameType?.value || 'cash');
        if (typeVal === 'scheduled') {
            const d = setupDate?.value || '';
            const t = setupTime?.value || '';
            if (!d || !t) {
                scheduledOk = false;
            } else {
                const [yy, mm, dd] = d.split('-').map(n=>parseInt(n,10));
                const [hh, mi] = t.split(':').map(n=>parseInt(n,10));
                const when = new Date(yy, (mm-1), dd, hh||0, mi||0, 0, 0);
                if (!(when instanceof Date) || isNaN(when.getTime())) {
                    scheduledOk = false;
                } else if (when.getTime() < Date.now() + 60*1000) { // at least 1 min ahead
                    scheduledOk = false;
                }
            }
        }
        const allValid = isNameValid && isPlayersValid && isStackValid && isSbValid && isBbValid && isTokenValid && isBuyinValid && isMinChipsValid && scheduledOk;

        createTableBtn.disabled = !allValid;
        createTableBtn.style.backgroundColor = allValid ? '#4CAF50' : '#ccc';
        createTableBtn.style.cursor = allValid ? 'pointer' : 'not-allowed';
        createTableBtn.style.color = allValid ? 'white' : '#666';
    };

    // Validate on change
    const setupInputs = [setupName, setupPlayers, setupStack, setupSB, setupBB, setupToken, setupBuyin, setupMinChips, setupDate, setupTime];
    setupInputs.forEach(input => { if (input) { input.addEventListener('input', validateSetupForm); input.addEventListener('change', validateSetupForm); } });

    // Visibility defaults
    if (authContainer) authContainer.style.display = 'flex';
    if (setupPanel) setupPanel.style.display = 'none';
    if (toggleLogBtn) toggleLogBtn.style.display = 'none';
    if (turnTimerEl) turnTimerEl.style.display = 'none';
    if (startGameBtn) startGameBtn.style.display = 'none';
    if (toggleProfileBtn) toggleProfileBtn.style.display = 'none';
    if (postLoginMenu) postLoginMenu.style.display = 'none';
    if (backToMenuBtn) backToMenuBtn.style.display = 'none';
    if (playerControls) playerControls.style.display = 'none';

    // Subscriptions bag
    let unsub = { tables:null, active:null, waitingPlayers:null, tableDoc:null, chat:null, game:null, boards:null };
    let currentWaiting = { tableId: null, myDocId: null, isHost: false, mode: null, lastStatus: null, enteredGame: false };
    let currentGame = { tableId: null, myDocId: null, lastState: null, control: null, phaseCue: null, bets: {}, ended: false, isAiTable: false, endTimeout: null, pendingConclusion: null };
    let actionInFlight = false;
    const clearGameEndTimer = () => {
        if (currentGame && currentGame.endTimeout) {
            window.clearTimeout(currentGame.endTimeout);
            currentGame.endTimeout = null;
        }
    };
    function cleanupRealtime() {
            try { unsub.tables && unsub.tables(); } catch(_) {}
            try { unsub.active && unsub.active(); } catch(_) {}
            try { unsub.waitingPlayers && unsub.waitingPlayers(); } catch(_) {}
            try { unsub.tableDoc && unsub.tableDoc(); } catch(_) {}
            try { unsub.chat && unsub.chat(); } catch(_) {}
            try { unsub.game && unsub.game(); } catch(_) {}
            try { unsub.boards && unsub.boards(); } catch(_) {}
            unsub = { tables:null, active:null, waitingPlayers:null, tableDoc:null, chat:null, game:null, boards:null };
            currentWaiting = { tableId: null, myDocId: null, isHost: false, mode: null, lastStatus: null, enteredGame: false };
            if (turnTimerInterval) {
                clearInterval(turnTimerInterval);
                turnTimerInterval = null;
            }
            resetGameView();
        }

    function hideAllPanels() {
        if (panelJoin) panelJoin.style.display = 'none';
        if (setupPanel) setupPanel.style.display = 'none';
        if (panelBoards) panelBoards.style.display = 'none';
        if (panelHelp) panelHelp.style.display = 'none';
        if (panelAI) panelAI.style.display = 'none';
        if (panelWaiting) panelWaiting.style.display = 'none';
        if (backToMenuBtn) backToMenuBtn.style.display = 'none';
        if (startGameBtn) startGameBtn.style.display = 'none';
        if (playerControls) playerControls.style.display = 'none';
    }
    function setMode(mode){
        const root = document.querySelector('.poker-module');
        if (!root) return;
        root.classList.remove('mode-menu','mode-game');
        root.classList.add(mode === 'game' ? 'mode-game' : 'mode-menu');
    }
    const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
    const SUIT_CLASSES = { s: 'black', c: 'black', h: 'red', d: 'red' };
    const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const SEAT_SEQUENCE_BY_COUNT = {
        1: [1],
        2: [1, 6],
        3: [1, 7, 6],
        4: [1, 7, 6, 4],
        5: [1, 7, 6, 4, 5],
        6: [1, 7, 6, 8, 4, 5],
        7: [1, 7, 6, 8, 4, 5, 2],
        8: [1, 7, 6, 8, 4, 5, 2, 3]  // MAX 8 players - seat 9 removed
    };
    const DEFAULT_SEAT_SEQUENCE = [1, 7, 6, 8, 4, 5, 2, 3];  // Seat 9 removed
    const SEAT_META = {
        1: { zone: 'south', side: 'center', cardsRight: false },
        2: { zone: 'south', side: 'east', cardsRight: true },
        3: { zone: 'south', side: 'west', cardsRight: false },
        4: { zone: 'east', side: 'east', cardsRight: true },
        5: { zone: 'west', side: 'west', cardsRight: false },
        6: { zone: 'north', side: 'east', cardsRight: true },
        7: { zone: 'north', side: 'west', cardsRight: false },
        8: { zone: 'north', side: 'center', cardsRight: true },
        9: { zone: 'north', side: 'center', cardsRight: false }
    };

    function resolveSeatSequence(playerCount, includeHero) {
        const cappedCount = Math.max(0, Math.min(playerCount, DEFAULT_SEAT_SEQUENCE.length));
        const base = (SEAT_SEQUENCE_BY_COUNT[cappedCount] || DEFAULT_SEAT_SEQUENCE).slice(0, cappedCount);
        if (includeHero) {
            if (!base.length) return [1];
            if (base[0] === 1) return base;
            const reordered = [1, ...base.filter((seat) => seat !== 1)];
            return reordered.slice(0, cappedCount);
        }
        const filtered = base.filter((seat) => seat !== 1);
        if (filtered.length >= cappedCount) {
            return filtered.slice(0, cappedCount);
        }
        const extras = DEFAULT_SEAT_SEQUENCE.filter((seat) => seat !== 1 && !filtered.includes(seat));
        return [...filtered, ...extras].slice(0, cappedCount);
    }

    const escapeHtml = (value) => {
        if (value == null) return '';
        return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] || ch);
    };

    function formatNumber(value, { fractionDigits = 2 } = {}) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return '0';
        try {
            const formatter = new Intl.NumberFormat('en-US', {
                minimumFractionDigits: fractionDigits,
                maximumFractionDigits: fractionDigits,
            });
            return formatter.format(numeric);
        } catch (_) {
            return String(numeric);
        }
    }

    function formatTokenAmount(units, { decimals = 18, fractionDigits = 4 } = {}) {
        if (units == null) return '0';
        let amount;
        try {
            amount = typeof units === 'bigint' ? units : BigInt(units);
        } catch (_) {
            return '0';
        }
        if (decimals < 0) decimals = 0;
        const safeFractionDigits = Math.max(0, Math.min(8, fractionDigits));
        const denom = 10n ** BigInt(decimals);
        if (denom === 0n) return amount.toString();
        const whole = amount / denom;
        const remainder = amount % denom;
        if (safeFractionDigits === 0 || remainder === 0n) {
            return whole.toString();
        }
        const scale = 10n ** BigInt(safeFractionDigits);
        const scaled = (remainder * scale) / denom;
        let frac = scaled.toString();
        if (scaled === 0n) {
            frac = ''.padStart(safeFractionDigits, '0');
        } else {
            frac = frac.padStart(safeFractionDigits, '0').replace(/0+$/g, '');
        }
        return frac ? `${whole.toString()}.${frac}` : whole.toString();
    }

    function flashHint(element) {
        if (!element) return;
        element.classList.add('is-alert');
        window.setTimeout(() => {
            element.classList.remove('is-alert');
        }, 1600);
    }

    function translateAiErrorMessage(raw) {
        if (raw == null) return 'Something went wrong. Please try again.';
        const original = String(raw).trim();
        if (!original) return 'Something went wrong. Please try again.';
        const lower = original.toLowerCase();
        if (lower.includes('not enough wbstr') || lower.includes('insufficient wbstr') || lower.includes('insufficient on-chain deposit') || lower.includes('insufficient amount')) {
            return 'Insufficient WBSTR balance. You need more WBSTR tokens to start this game. Top up your wallet or reduce the buy-in amount.';
        }
        if (lower.includes('wallet not connected')) {
            return 'Connect your wallet before starting a Play vs PC match.';
        }
        if (lower.includes('unable to create ai') || lower.includes('error creating ai')) {
            return 'We could not create the Play vs PC table. Please try again in a few seconds.';
        }
        if (lower.includes('key manager') || lower.includes('permission fix')) {
            return 'Your Universal Profile needs updated permissions. Approve the permission request in your wallet and try again.';
        }
        if (lower.includes('user rejected') || lower.includes('action_rejected') || lower.includes('transaction was rejected')) {
            return 'Transaction was cancelled in your wallet. No changes were made.';
        }
        if (lower.includes('wbstr token is currently not allowed')) {
            return 'WBSTR deposits are currently disabled for this table. Contact the operator to enable WBSTR on the vault.';
        }
        if (lower.includes('missing provider')) {
            return 'We could not reach the blockchain provider. Refresh the page or reconnect your wallet.';
        }
        return original;
    }

    function normalizeCard(code) {
        if (!code || typeof code !== 'string') return null;
        const trimmed = code.trim();
        if (trimmed.length < 2) return null;
        const suit = trimmed.slice(-1).toLowerCase();
        const rawRank = trimmed.slice(0, -1).toUpperCase();
        const rank = rawRank === 'T' ? '10' : rawRank;
        return {
            rank,
            symbol: SUIT_SYMBOLS[suit] || '?',
            cls: SUIT_CLASSES[suit] || 'black'
        };
    }

    const toCardKey = (value) => {
        if (!value && value !== 0) return '';
        return String(value).replace(/\s+/g, '').toUpperCase();
    };

    function renderCardHtml(code, reveal = true, size = 'regular', options = {}) {
        const sizeClass = size === 'small' ? ' small' : size === 'board' ? ' board' : size === 'hero' ? ' hero' : '';
        const highlightClass = options.highlight ? ' highlight' : '';
        if (!reveal) {
            return `<div class="card back${sizeClass}"></div>`;
        }
        const normalized = normalizeCard(code);
        if (!normalized) {
            return `<div class="card${sizeClass}"></div>`;
        }
    return `<div class="card ${normalized.cls}${sizeClass}${highlightClass}"><span class="card-rank">${normalized.rank}</span><span class="card-suit">${normalized.symbol}</span><span class="card-center">${normalized.symbol}</span></div>`;
    }

    function setControlEnabled(el, enabled) {
        if (!el) return;
        el.disabled = !enabled;
        if (enabled) {
            el.classList.remove('disabled');
        } else {
            el.classList.add('disabled');
        }
    }

    function resetGameView() {
        clearGameEndTimer();
        if (communityCardsEl) communityCardsEl.innerHTML = '';
        if (potEl) potEl.textContent = '0';
        if (sidePotsEl) sidePotsEl.innerHTML = '';
        seatEntries.forEach((entry) => clearSeat(entry));
        if (wagerValueEl) wagerValueEl.textContent = '0';
        if (gameMessageEl) gameMessageEl.textContent = '';
        clearPotPulse();
        if (phaseBannerTimer) {
            clearTimeout(phaseBannerTimer);
            phaseBannerTimer = null;
        }
        if (phaseBannerEl) {
            phaseBannerEl.textContent = '';
            phaseBannerEl.classList.remove('show');
        }
        if (playerControls) {
            playerControls.style.display = 'none';
            playerControls.classList.remove('is-active', 'is-waiting', 'has-call');
            playerControls.removeAttribute('data-action-type');
        }
        if (tableAreaEl) tableAreaEl.classList.add('is-hidden');
        if (betAmountInput) {
            betAmountInput.value = '';
            betAmountInput.disabled = true;
        }
    currentGame = { tableId: null, myDocId: null, lastState: null, control: null, phaseCue: null, bets: {}, ended: false, isAiTable: false, endTimeout: null, pendingConclusion: null };
        updateGameControls(null);
    }

    function renderBoard(state, previousState = null) {
        const cards = state && Array.isArray(state.board) ? state.board : [];
        const showdown = state?.showdownSummary || {};
        const showdownHands = showdown?.hands || {};
        const showdownWinners = Array.isArray(showdown?.winners) ? showdown.winners : [];
        const winningBoardCards = new Set();
        showdownWinners.forEach((pid) => {
            const summary = showdownHands?.[pid];
            if (!summary || !Array.isArray(summary.bestCards)) return;
            summary.bestCards.forEach((code) => {
                const key = toCardKey(code);
                if (key) winningBoardCards.add(key);
            });
        });
        if (communityCardsEl) {
            communityCardsEl.innerHTML = cards.map((card) => {
                const highlight = winningBoardCards.has(toCardKey(card));
                return renderCardHtml(card, true, 'board', { highlight });
            }).join('');
        }
        const numericPot = Number(state?.pot || 0);
        const previousPot = Number(previousState?.pot || 0);
        if (potEl) {
            potEl.textContent = formatNumber(numericPot, { fractionDigits: 0 });
        }
        if (potContainerEl) {
            if (Number.isFinite(numericPot) && Number.isFinite(previousPot) && numericPot > previousPot) {
                triggerPotPulse();
            } else if (!(numericPot > 0)) {
                clearPotPulse();
            }
        }
        if (sidePotsEl) {
            if (state && Array.isArray(state.sidePots) && state.sidePots.length) {
                sidePotsEl.innerHTML = state.sidePots
                    .filter((amt) => (amt || 0) > 0)
                    .map((amt, idx) => `<div class="side-pot">Side pot ${idx + 1}: ${formatNumber(amt, { fractionDigits: 0 })}</div>`)
                    .join('');
            } else {
                sidePotsEl.innerHTML = '';
            }
        }
    }
    function updateBetButtonDisplay() {
        if (!betBtn) return;
        const ctrl = currentGame.control;
        if (!ctrl || !ctrl.canAct || ctrl.sliderMax <= 0) {
            const standby = ctrl && ctrl.actionType === 'raise' ? 'Raise' : 'Bet';
            betBtn.innerHTML = `${standby} <span>-</span>`;
            if (wagerValueEl) wagerValueEl.textContent = '—';
            return;
        }
        let sliderVal = ctrl.sliderValue;
        if (betSlider && !betSlider.disabled) {
            const currentVal = Number(betSlider.value);
            if (Number.isFinite(currentVal)) sliderVal = currentVal;
        }
        let sanitized = sliderVal;
        if (Number.isNaN(sanitized)) sanitized = ctrl.sliderMin;
        sanitized = Math.max(ctrl.sliderMin || 0, Math.min(ctrl.sliderMax || sanitized, sanitized));
        if (betSlider && !betSlider.disabled) {
            betSlider.value = String(sanitized);
        }
        if (betAmountInput && !betAmountInput.disabled) {
            betAmountInput.value = String(sanitized);
        }
        const total = ctrl.actionType === 'bet' ? sanitized : sanitized + ctrl.toCall;
        const label = ctrl.actionType === 'bet' ? 'Bet' : 'Raise to';
        const formattedTotal = formatNumber(total, { fractionDigits: 0 });
        betBtn.innerHTML = `${label} <span>${formattedTotal}</span>`;
        if (wagerValueEl) wagerValueEl.textContent = formattedTotal;
    }
    
    /**
     * Start turn timer countdown
     * @param {Object} state - Game state with lastActionAt timestamp
     * @param {boolean} isMyTurn - Whether it's the current player's turn
     */
    function startTurnTimer(state, isMyTurn) {
        // Clear any existing timer
        if (turnTimerInterval) {
            clearInterval(turnTimerInterval);
            turnTimerInterval = null;
        }
        
        if (!turnTimerEl) return;
        
        // Hide timer if not in active game or no lastActionAt
        if (!state || !state.lastActionAt || !isMyTurn) {
            turnTimerEl.textContent = '';
            turnTimerEl.style.display = 'none';
            return;
        }
        
        const TIMEOUT_SECONDS = 60; // Must match backend TIME_BANK_SECONDS
        
        // Function to update timer display
        const updateTimer = () => {
            try {
                const lastActionAt = state.lastActionAt.toDate ? state.lastActionAt.toDate() : new Date(state.lastActionAt);
                const now = new Date();
                const elapsedSeconds = Math.floor((now - lastActionAt) / 1000);
                const remainingSeconds = Math.max(0, TIMEOUT_SECONDS - elapsedSeconds);
                
                if (remainingSeconds <= 0) {
                    turnTimerEl.textContent = '⏱ 0s';
                    turnTimerEl.style.display = 'block';
                    turnTimerEl.style.color = '#ff4444'; // Red when timeout
                    if (turnTimerInterval) {
                        clearInterval(turnTimerInterval);
                        turnTimerInterval = null;
                    }
                    return;
                }
                
                // Color coding based on remaining time
                let color = '#4ade80'; // Green (>30s)
                if (remainingSeconds <= 10) {
                    color = '#ff4444'; // Red (<= 10s)
                } else if (remainingSeconds <= 30) {
                    color = '#fbbf24'; // Yellow (<= 30s)
                }
                
                turnTimerEl.textContent = `⏱ ${remainingSeconds}s`;
                turnTimerEl.style.display = 'block';
                turnTimerEl.style.color = color;
                turnTimerEl.style.fontWeight = 'bold';
            } catch (e) {
                console.warn('Failed to update turn timer:', e);
            }
        };
        
        // Initial update
        updateTimer();
        
        // Update every second
        turnTimerInterval = setInterval(updateTimer, 1000);
    }

    function updateGameControls(state) {
        if (!playerControls) return;
        if (!state || !currentGame.tableId) {
            playerControls.style.display = 'none';
            playerControls.classList.remove('is-active', 'is-waiting');
            playerControls.removeAttribute('data-action-type');
            currentGame.control = null;
            if (betSlider) betSlider.disabled = true;
            if (betAmountInput) {
                betAmountInput.disabled = true;
                betAmountInput.value = '';
            }
            updateBetButtonDisplay();
            return;
        }

        const myId = currentGame.myDocId;
        const me = myId ? state.players?.[myId] : null;
        if (!me) {
            playerControls.style.display = 'none';
            playerControls.classList.remove('is-active', 'is-waiting');
            playerControls.removeAttribute('data-action-type');
            currentGame.control = null;
            updateBetButtonDisplay();
            return;
        }

        playerControls.style.display = 'grid';
        const myTurn = !!(me && state.turn === myId && me.inHand && !me.folded);
        const stack = me ? Math.max(0, me.stack || 0) : 0;
        const myBet = me ? Math.max(0, me.bet || 0) : 0;
        const currentBet = Math.max(0, state.currentBet || 0);
        const toCall = Math.max(0, currentBet - myBet);
        const minRaise = Math.max(1, state.minRaise || state.bb || state.sb || 1);
        const sliderStep = Math.max(1, state.sb || 1);
        // Determine actionType: if you have already bet (e.g. BB), it's a raise, not a bet
        let actionType = (toCall === 0 && myBet > 0) ? 'raise' : (toCall === 0 ? 'bet' : 'raise');
        let sliderMin = 0;
        let sliderMax = 0;
        let sliderValue = 0;
        let sliderEnabled = false;

        if (actionType === 'bet') {
            sliderMin = Math.max(minRaise, 1);
            sliderMax = stack;
            if (stack > 0) {  // Enable betting if you have any chips
                sliderEnabled = true;
                // If you have less than minRaise, you can only bet your stack (all-in)
                if (stack < sliderMin) {
                    sliderMin = stack;
                    sliderValue = stack;
                } else {
                    sliderValue = Math.max(sliderMin, Math.min(sliderMax, Math.round(sliderMax * 0.6) || sliderMin));
                }
            }
        } else {
            const raiseRoom = Math.max(0, stack - toCall);
            sliderMin = Math.max(minRaise, 1);
            sliderMax = raiseRoom;
            if (raiseRoom > 0) {  // Enable raise if you have any chips after the call
                sliderEnabled = true;
                // If you have less than minRaise to raise, you can only raise what you have
                if (raiseRoom < sliderMin) {
                    sliderMin = raiseRoom;
                    sliderValue = raiseRoom;
                } else {
                    sliderValue = Math.max(sliderMin, Math.min(sliderMax, sliderMin));
                }
            }
        }

        if (!myTurn) sliderEnabled = false;

        currentGame.control = {
            actionType,
            toCall,
            sliderMin: sliderEnabled ? sliderMin : 0,
            sliderMax: sliderEnabled ? sliderMax : 0,
            sliderStep,
            sliderValue: sliderEnabled ? sliderValue : 0,
            stack,
            canAct: myTurn
        };

        if (betSlider) {
            if (sliderEnabled) {
                betSlider.disabled = false;
                betSlider.min = String(sliderMin);
                betSlider.max = String(sliderMax);
                betSlider.step = String(sliderStep);
                betSlider.value = String(sliderValue);
            } else {
                betSlider.disabled = true;
            }
        }

        if (betAmountInput) {
            if (sliderEnabled) {
                betAmountInput.disabled = false;
                betAmountInput.min = String(Math.max(0, sliderMin));
                betAmountInput.max = String(Math.max(sliderMin, sliderMax));
                betAmountInput.step = String(Math.max(1, sliderStep));
                betAmountInput.value = String(sliderValue);
            } else {
                betAmountInput.disabled = true;
                betAmountInput.value = '';
            }
        }

        if (checkBtn) {
            checkBtn.style.display = toCall === 0 ? 'inline-block' : 'none';
        }
        if (callBtn) {
            callBtn.style.display = toCall > 0 ? 'inline-block' : 'none';
            if (toCall > 0) {
                const callAmount = Math.min(toCall, stack);
                callBtn.textContent = `Call ${formatNumber(callAmount, { fractionDigits: 0 })}`;
            } else {
                callBtn.textContent = 'Call';
            }
        }
        if (foldBtn) foldBtn.textContent = 'Fold';
        if (allInBtn) {
            allInBtn.textContent = stack > 0 ? `All-in (${formatNumber(stack, { fractionDigits: 0 })})` : 'All-in';
        }

        setControlEnabled(foldBtn, myTurn && !!me);
        setControlEnabled(checkBtn, myTurn && toCall === 0);
        setControlEnabled(callBtn, myTurn && toCall > 0 && stack > 0);
        setControlEnabled(betBtn, myTurn && sliderEnabled);
        setControlEnabled(allInBtn, myTurn && stack > 0);

        if (sliderEnabled) {
            if (betSlider && !betSlider.disabled) {
                currentGame.control.sliderValue = Number(betSlider.value);
            } else if (betAmountInput && !betAmountInput.disabled) {
                currentGame.control.sliderValue = Number(betAmountInput.value);
            }
        }

        playerControls.classList.toggle('is-active', myTurn);
        playerControls.classList.toggle('is-waiting', !myTurn);
        playerControls.classList.toggle('has-call', toCall > 0);
        playerControls.classList.toggle('hero-turn', myTurn);
        playerControls.setAttribute('data-action-type', actionType);

        updateBetButtonDisplay();
        
        // Start/update turn timer
        startTurnTimer(state, myTurn);
    }

    function updateGameView(state) {
        const previousState = currentGame.lastState || null;
        currentGame.lastState = state || null;
        
        // Update activeGame timestamp in localStorage when the state changes
        // This also allows reconnecting during the game
        if (state && currentGame.tableId && !currentGame.ended) {
            try {
                const existing = localStorage.getItem('activeGame');
                if (existing) {
                    const gameData = JSON.parse(existing);
                    // Update only the timestamp, keep other data
                    gameData.timestamp = Date.now();
                    localStorage.setItem('activeGame', JSON.stringify(gameData));
                }
            } catch (e) {
                console.warn('Failed to update activeGame timestamp:', e);
            }
        }
        
        if (!state) {
            renderBoard(null, previousState);
            renderGamePlayers(null);
            updateGameControls(null);
            currentGame.phaseCue = null;
            setMessage('Waiting for game state…');
            return;
        }
        renderBoard(state, previousState);
        renderGamePlayers(state);
        updateGameControls(state);
        const phase = String(state.phase || '-').toUpperCase();
    if (phase && phase !== '-' && phase !== 'WAITING' && phase !== currentGame.phaseCue) {
            currentGame.phaseCue = phase;
            displayPhaseBanner(phase);
        }
        const potValue = formatNumber(state.pot || 0, { fractionDigits: 0 });
        const sb = formatNumber(state.sb || 0, { fractionDigits: 0 });
        const bb = formatNumber(state.bb || 0, { fractionDigits: 0 });
        const myId = currentGame.myDocId;
        const me = myId ? state.players?.[myId] : null;
        const myTurn = !!(me && state.turn === myId && me.inHand && !me.folded);
        const turnPlayer = state.turn ? state.players?.[state.turn] : null;
        const blindsLabel = state.sb || state.bb ? `Blinds ${sb} / ${bb}` : '';
        let infoParts = [`Pot ${potValue}`];
        if (blindsLabel) infoParts.push(blindsLabel);
        let message = infoParts.join(' • ');
        if (myTurn) {
            message = `Your turn • ${message}`;
        } else if (turnPlayer) {
            const name = escapeHtml(turnPlayer.name || 'Player');
            const prefix = turnPlayer.bot ? `Bot ${name}` : name;
            message = `${prefix} is thinking • ${message}`;
        }
        if (phase === 'SHOWDOWN' && state.showdownSummary) {
            const winnersArr = Array.isArray(state.showdownSummary.winners) ? state.showdownSummary.winners : [];
            if (winnersArr.length) {
                const winnerNames = winnersArr.map((pid) => escapeHtml(state.players?.[pid]?.name || pid));
                const comboNames = winnersArr
                    .map((pid) => state.showdownSummary?.hands?.[pid]?.name)
                    .filter((name) => !!name)
                    .map((name) => String(name).toUpperCase());
                const comboLabel = comboNames.length === 1 ? comboNames[0] : '';
                message = `SHOWDOWN • Winner${winnersArr.length > 1 ? 's' : ''}: ${winnerNames.join(', ')}`;
                if (comboLabel) {
                    message += ` (${comboLabel})`;
                }
            }
        }
        setMessage(message);
    }

    const setMessage = (txt) => { if (gameMessageEl) gameMessageEl.textContent = txt || ''; };

    function ensureAiResultOverlay() {
        if (aiResultOverlay) return aiResultOverlay;
        const root = document.createElement('div');
        root.className = 'ai-result-overlay hidden';
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `
            <div class="ai-result-card" role="dialog" aria-modal="true" aria-live="assertive">
                <div class="ai-result-title"></div>
                <p class="ai-result-message"></p>
                <ul class="ai-result-detail"></ul>
                <p class="ai-result-countdown"></p>
                <button type="button" class="control-btn primary ai-result-cta">Back to lobby now</button>
            </div>
        `;
        document.body.appendChild(root);
        const titleEl = root.querySelector('.ai-result-title');
        const messageEl = root.querySelector('.ai-result-message');
        const detailEl = root.querySelector('.ai-result-detail');
        const countdownEl = root.querySelector('.ai-result-countdown');
        const buttonEl = root.querySelector('.ai-result-cta');
        aiResultOverlay = {
            root,
            titleEl,
            messageEl,
            detailEl,
            countdownEl,
            buttonEl,
            menuMessage: null
        };
        if (buttonEl) {
            buttonEl.addEventListener('click', () => {
                const lobbyMessage = aiResultOverlay?.menuMessage || 'Ready for another challenge? Select “Play vs PC” to start again.';
                hideAiResultOverlay();
                showMainMenu(lobbyMessage);
            });
        }
        return aiResultOverlay;
    }

    function hideAiResultOverlay() {
        if (aiResultCountdownTimer) {
            window.clearInterval(aiResultCountdownTimer);
            aiResultCountdownTimer = null;
        }
        if (!aiResultOverlay) return;
        aiResultOverlay.root.classList.add('hidden');
        aiResultOverlay.root.setAttribute('aria-hidden', 'true');
        if (aiResultOverlay.detailEl) aiResultOverlay.detailEl.innerHTML = '';
        if (aiResultOverlay.countdownEl) aiResultOverlay.countdownEl.textContent = '';
        aiResultOverlay.menuMessage = null;
    }

    function showAiResultOverlay({ outcome, headline, body, detailLines = [], countdownMs = 8000, menuMessage }) {
        const overlay = ensureAiResultOverlay();
        overlay.root.classList.remove('hidden');
        overlay.root.setAttribute('aria-hidden', 'false');
        overlay.root.classList.toggle('win', outcome === 'win');
        overlay.root.classList.toggle('loss', outcome !== 'win');
        if (overlay.titleEl) overlay.titleEl.textContent = headline || (outcome === 'win' ? 'You won!' : 'House wins');
        if (overlay.messageEl) overlay.messageEl.textContent = body || '';
        if (overlay.detailEl) {
            const safeLines = Array.isArray(detailLines) ? detailLines.filter(Boolean) : [];
            if (safeLines.length) {
                overlay.detailEl.innerHTML = safeLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
                overlay.detailEl.style.display = 'block';
            } else {
                overlay.detailEl.innerHTML = '';
                overlay.detailEl.style.display = 'none';
            }
        }
        if (overlay.buttonEl) {
            overlay.buttonEl.textContent = outcome === 'win' ? 'Go to lobby now' : 'Back to lobby now';
        }
        const totalSeconds = Math.max(2, Math.round(countdownMs / 1000));
        let remaining = totalSeconds;
        if (overlay.countdownEl) {
            overlay.countdownEl.textContent = `Returning to the lobby in ${remaining}s…`;
        }
        if (aiResultCountdownTimer) {
            window.clearInterval(aiResultCountdownTimer);
            aiResultCountdownTimer = null;
        }
        aiResultCountdownTimer = window.setInterval(() => {
            remaining -= 1;
            if (!overlay.countdownEl) return;
            if (remaining <= 0) {
                overlay.countdownEl.textContent = 'Returning to the lobby…';
                window.clearInterval(aiResultCountdownTimer);
                aiResultCountdownTimer = null;
            } else {
                overlay.countdownEl.textContent = `Returning to the lobby in ${remaining}s…`;
            }
        }, 1000);
        overlay.menuMessage = menuMessage || body || (outcome === 'win'
            ? 'Victory! Your WBSTR reward is on the way. Head back to the lobby for the next challenge.'
            : 'The house won this round. You can launch another challenge from the lobby.');
        return overlay;
    }

    function scheduleAiConclusion(outcome, { delayMs = 8000, tableDoc = null } = {}) {
        if (!currentGame || currentGame.ended) return;
        clearGameEndTimer();
        currentGame.ended = true;
        currentGame.pendingConclusion = null;
        const win = outcome === 'win';
        const banner = win ? 'YOU WIN' : 'HOUSE WINS';
        const inlineMessage = win
            ? 'You won the challenge! Your WBSTR reward is being processed on-chain.'
            : 'The house won this round. Your buy-in has been forfeited.';
        displayPhaseBanner(banner);
        setMessage(inlineMessage);
        
        // Počisti activeGame iz localStorage ko se igra konča
        try {
            localStorage.removeItem('activeGame');
        } catch (e) {
            console.warn('Failed to clear activeGame from localStorage:', e);
        }
        
        // Record to leaderboard when player wins
        if (win && selectedAccount && tableDoc) {
            const buyinAmount = tableDoc.buyin || 0;
            const chipsWon = buyinAmount * 2; // Player wins double the buy-in
            recordLeaderboardEntry({ 
                user: selectedAccount, 
                chipsWon: chipsWon 
            }).catch(err => {
                console.error('Failed to record leaderboard entry:', err);
            });
            
            // Update claim button states immediately after win, with retry
            // Backend might need a moment to finalize the table status
            const updateClaimWithRetry = async (attempts = 3) => {
                for (let i = 0; i < attempts; i++) {
                    try {
                        await updateClaimButtonStates();
                        break; // Success, exit loop
                    } catch (err) {
                        console.error(`Failed to update claim button states (attempt ${i+1}/${attempts}):`, err);
                        if (i < attempts - 1) {
                            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
                        }
                    }
                }
            };
            updateClaimWithRetry();
        }
        
        if (playerControls) {
            playerControls.style.display = 'none';
            playerControls.classList.remove('is-active', 'is-waiting', 'has-call');
            playerControls.removeAttribute('data-action-type');
        }
        if (backToMenuBtn) backToMenuBtn.style.display = 'inline-block';
        const overlay = showAiResultOverlay({
            outcome: win ? 'win' : 'loss',
            headline: win ? 'You are the winner! 🎉' : 'House wins this time',
            body: inlineMessage,
            detailLines: win
                ? [
                    'Rewards are sent automatically once the blockchain confirms the payout.',
                    'Track payouts anytime under Profile → Rewards.'
                ]
                : [
                    'Your staked funds have been transferred to the house wallet.',
                    'Start a new game anytime from “Play vs PC”.'
                ],
            countdownMs: delayMs,
            menuMessage: win
                ? 'Victory! Your WBSTR reward will show up under Rewards shortly.'
                : 'The house won this round. Ready for a rematch? Choose “Play vs PC”.'
        });
        currentGame.endTimeout = window.setTimeout(() => {
            const lobbyMessage = overlay?.menuMessage || inlineMessage;
            showMainMenu(lobbyMessage);
        }, Math.max(0, delayMs));
    }

    function displayPhaseBanner(label) {
        if (!phaseBannerEl) return;
        const trimmed = String(label || '').trim();
        if (!trimmed) {
            phaseBannerEl.classList.remove('show');
            return;
        }
        phaseBannerEl.textContent = trimmed;
        phaseBannerEl.classList.add('show');
        if (phaseBannerTimer) clearTimeout(phaseBannerTimer);
        phaseBannerTimer = window.setTimeout(() => {
            phaseBannerEl.classList.remove('show');
        }, 2600);
    }

    const INLINE_FEEDBACK_TIMEOUT_MS = 4500;

    const setClaimStatus = (txt) => {
        if (claimStatusEl) claimStatusEl.textContent = txt || '';
    };

    const clearInlineClaimFeedback = () => {
        if (!inlineClaimFeedback) return;
        inlineClaimFeedback.textContent = '';
        inlineClaimFeedback.classList.remove('is-success', 'is-error');
        inlineClaimFeedback.style.visibility = 'hidden';
        if (inlineFeedbackTimer) {
            clearTimeout(inlineFeedbackTimer);
            inlineFeedbackTimer = null;
        }
    };

    const showInlineClaimFeedback = (message, tone = 'neutral', { persistMs = INLINE_FEEDBACK_TIMEOUT_MS } = {}) => {
        if (!inlineClaimFeedback) return;
        if (inlineFeedbackTimer) {
            clearTimeout(inlineFeedbackTimer);
            inlineFeedbackTimer = null;
        }
        if (!message) {
            clearInlineClaimFeedback();
            return;
        }
        inlineClaimFeedback.textContent = message;
        inlineClaimFeedback.style.visibility = 'visible';
        inlineClaimFeedback.classList.remove('is-success', 'is-error');
        if (tone === 'success') inlineClaimFeedback.classList.add('is-success');
        if (tone === 'error') inlineClaimFeedback.classList.add('is-error');
        if (persistMs > 0) {
            inlineFeedbackTimer = window.setTimeout(() => {
                clearInlineClaimFeedback();
            }, persistMs);
        }
    };

    if (inlineClaimFeedback) {
        clearInlineClaimFeedback();
    }

    async function handleClaimRewards({ source } = {}) {
        let restorePopupLabel = null;
        try {
            if (!window.__upAddress) throw new Error('Connect your profile to claim rewards.');
            if (claimRewardsButtonPopup) {
                restorePopupLabel = claimRewardsButtonPopup.textContent;
                claimRewardsButtonPopup.disabled = true;
                claimRewardsButtonPopup.textContent = 'Claiming…';
            }
            if (source === 'inline' && inlineClaimBtn) {
                inlineClaimBtn.disabled = true;
                inlineClaimBtn.textContent = 'Checking…';
            }
            setClaimStatus('Checking rewards…');
            if (source === 'inline') showInlineClaimFeedback('Checking rewards…');
            const addr = window.__upAddress;
            const summary = await getClaimSummary(addr, { force: true });
            await updateClaimButtonStates();
            const entries = Array.isArray(summary?.entries) ? summary.entries.filter((entry) => entry && entry.amount && entry.amount > 0n) : [];
            if (!entries.length) {
                const result = 'No rewards to claim.';
                setClaimStatus(result);
                setMessage(result);
                if (source === 'inline') showInlineClaimFeedback(result, 'neutral');
                return;
            }
            const txHashes = [];
            for (const entry of entries) {
                const { txHash } = await claimPrize(entry.token);
                if (txHash) txHashes.push(txHash);
            }
            const uniqueHashes = Array.from(new Set(txHashes.filter(Boolean)));
            const hashLabel = uniqueHashes.length ? ` Tx: ${uniqueHashes.map((h) => shortenTxHash(h)).join(', ')}` : '';
            const result = `Claimed ${entries.length} reward${entries.length === 1 ? '' : 's'}. Check your wallet for the transaction confirmation.${hashLabel ? hashLabel : ''}`;
            setClaimStatus(result);
            setMessage(result);
            if (source === 'inline') {
                showInlineClaimFeedback(result, 'success');
            }
            await Promise.all([
                refreshWbstrSummary({ force: true }),
                refreshProfilePopup({ forceClaimSummary: true })
            ]);
        } catch (err) {
            const rawMsg = err?.message || String(err);
            const lowered = rawMsg.toLowerCase();
            const friendly = (lowered.includes('action_rejected') || lowered.includes('user rejected') || lowered.includes('denied'))
                ? 'Claim cancelled in wallet.'
                : rawMsg;
            setClaimStatus(friendly);
            setMessage(friendly);
            if (source === 'inline') showInlineClaimFeedback(friendly, 'error', { persistMs: 6000 });
        } finally {
            if (claimRewardsButtonPopup) {
                claimRewardsButtonPopup.disabled = false;
                if (restorePopupLabel != null) claimRewardsButtonPopup.textContent = restorePopupLabel;
            }
            if (source === 'inline' && inlineClaimBtn) {
                inlineClaimBtn.disabled = false;
                await updateClaimButtonStates();
            }
        }
    }

    async function handleClaimAll({ source } = {}) {
        console.log('🎯 handleClaimAll called, source:', source);
        let menuBtnPrev = null;
        let popupPrev = null;
        const txHashes = [];
        try {
            if (!window.__upAddress) throw new Error('Connect your profile to claim rewards.');
            
            menuBtnPrev = menuClaimBtn ? menuClaimBtn.textContent : null;
            if (source === 'menu' && menuClaimBtn) {
                menuClaimBtn.disabled = true;
                menuClaimBtn.textContent = 'Claiming…';
            }
            popupPrev = claimAllButtonPopup ? claimAllButtonPopup.textContent : null;
            if (claimAllButtonPopup) {
                claimAllButtonPopup.disabled = true;
                claimAllButtonPopup.textContent = 'Claiming…';
            }
            
            setClaimStatus('Checking for locked funds…');
            if (source === 'menu') showInlineClaimFeedback('Checking for locked funds…');
            
            // Get table IDs where player has deposited
            const tableIds = getPlayerTableIds(window.__upAddress);
            console.log('📊 Player has deposited to tables:', tableIds);
            
            if (!tableIds.length) {
                const result = 'No deposits found. Play a game first to earn rewards.';
                setClaimStatus(result);
                setMessage(result);
                if (source === 'menu') showInlineClaimFeedback(result, 'neutral');
                return;
            }
            
            // Check balances for each table (WBSTR token)
            const token = WBSTR_TOKEN_ADDRESS || ZERO_ADDRESS;
            const withdrawals = [];
            
            for (const tableInfo of tableIds) {
                const onchainId = tableInfo.onchainId;
                const firestoreId = tableInfo.firestoreId;
                try {
                    const balance = await getVaultBalance(onchainId, window.__upAddress, token);
                    console.log(`💰 Table ${firestoreId} (onchain: ${onchainId}) balance:`, balance.toString());
                    if (balance > 0n) {
                        withdrawals.push({ onchainId, firestoreId, balance });
                    }
                } catch (err) {
                    console.warn(`Failed to check balance for table ${firestoreId}:`, err);
                }
            }
            
            if (!withdrawals.length) {
                // Check if player has any deposited tables at all
                const hasPlayedGames = tableIds && tableIds.length > 0;
                
                let result;
                if (!hasPlayedGames) {
                    result = `🎮 No winnings available yet. Play a game against AI to earn ${TOKEN_SYMBOL} rewards!`;
                } else {
                    result = '⏳ No locked funds found. Your winnings may have been claimed already, or your recent game is still being processed. If you just won, please wait 2-3 minutes for the blockchain to finalize your payout, then try claiming again. Your funds are safe!';
                }
                
                setClaimStatus(result);
                setMessage(result);
                if (source === 'menu') showInlineClaimFeedback(result, hasPlayedGames ? 'neutral' : 'info');
                return;
            }
            
            console.log('💸 Found withdrawals:', withdrawals);
            setClaimStatus(`Found ${ethers.formatUnits(withdrawals.reduce((s,w) => s + w.balance, 0n), 18)} ${TOKEN_SYMBOL} in ${withdrawals.length} game${withdrawals.length === 1 ? '' : 's'}. Please approve the transaction in your wallet…`);
            if (source === 'menu') showInlineClaimFeedback('Preparing withdrawal… Please check your wallet for approval.');
            
            // Execute withdrawals
            for (const { onchainId, firestoreId, balance } of withdrawals) {
                try {
                    console.log(`🏦 Withdrawing ${balance} from table ${firestoreId} (onchain: ${onchainId})…`);
                    const { txHash } = await withdrawFromVault(onchainId, token, balance);
                    if (txHash) txHashes.push(txHash);
                    console.log(`✅ Withdrawn from table ${firestoreId}`);
                } catch (err) {
                    console.error(`❌ Failed to withdraw from table ${firestoreId}:`, err);
                    
                    // Special handling for authorization errors
                    if (err.message && err.message.includes('insufficient authorization')) {
                        const authErrorMsg = 'Your winnings are still being processed by the game server. Please wait 2-3 minutes and try claiming again. The funds are safe and ready for you!';
                        setClaimStatus(authErrorMsg);
                        setMessage(authErrorMsg);
                        if (source === 'menu') showInlineClaimFeedback(authErrorMsg, 'info');
                        return; // Stop processing other withdrawals
                    }
                    
                    // Continue with other tables for other errors
                }
            }
            
            const uniqueTxHashes = Array.from(new Set(txHashes.filter(Boolean)));
            const hashLabel = uniqueTxHashes.length ? ` Tx: ${uniqueTxHashes.map((h) => shortenTxHash(h)).join(', ')}` : '';
            
            // Calculate total amount claimed (sum all balances)
            const totalClaimed = withdrawals.reduce((sum, w) => sum + w.balance, 0n);
            const totalWbstr = ethers.formatUnits(totalClaimed, 18);
            
            const result = txHashes.length > 0
                ? `🎉 Successfully claimed ${totalWbstr} ${TOKEN_SYMBOL} from ${txHashes.length} game${txHashes.length === 1 ? '' : 's'}! Check your wallet.${hashLabel}`
                : 'No funds were withdrawn. They may have already been claimed or are still processing. Please wait 2 minutes and try again.';
            
            setClaimStatus(result);
            setMessage(result);
            if (source === 'menu') showInlineClaimFeedback(result, txHashes.length > 0 ? 'success' : 'neutral');
            
            await Promise.all([
                refreshWbstrSummary({ force: true }),
                refreshProfilePopup({ forceClaimSummary: true })
            ]);
        } catch (err) {
            console.error('❌ handleClaimAll error:', err);
            const rawMsg = err?.message || String(err);
            const lowered = rawMsg.toLowerCase();
            
            let friendly;
            if (lowered.includes('action_rejected') || lowered.includes('user rejected') || lowered.includes('denied')) {
                friendly = 'Claim cancelled in wallet.';
            } else if (lowered.includes('insufficient authorization')) {
                friendly = 'Your winnings are still being processed on the blockchain. Please wait 2 minutes and try again.';
            } else if (lowered.includes('no locked funds') || lowered.includes('balance: 0')) {
                friendly = 'No funds available to claim. If you just won, please wait 2 minutes for blockchain processing.';
            } else {
                friendly = rawMsg;
            }
            
            setClaimStatus(friendly);
            setMessage(friendly);
            if (source === 'menu') showInlineClaimFeedback(friendly, 'error', { persistMs: 6000 });
        } finally {
            if (menuClaimBtn && source === 'menu') {
                menuClaimBtn.disabled = false;
                if (menuBtnPrev != null) menuClaimBtn.textContent = menuBtnPrev;
            }
            if (claimAllButtonPopup) {
                claimAllButtonPopup.disabled = false;
                if (popupPrev != null) claimAllButtonPopup.textContent = popupPrev;
            }
        }
    }

    const quantizeSliderValue = (value, ctrl) => {
        if (!ctrl) return 0;
        let next = Number(value);
        if (!Number.isFinite(next)) next = ctrl.sliderMin || 0;
        const step = Math.max(1, ctrl.sliderStep || 1);
        if (step > 0) {
            next = Math.round(next / step) * step;
        }
        if (ctrl.sliderMin != null) next = Math.max(ctrl.sliderMin, next);
        if (ctrl.sliderMax != null && ctrl.sliderMax > 0) next = Math.min(ctrl.sliderMax, next);
        if (next < 0) next = 0;
        return next;
    };

    const syncBetSlider = (rawValue) => {
        const ctrl = currentGame.control;
        if (!ctrl) return;
        const quantized = quantizeSliderValue(rawValue != null ? rawValue : ctrl.sliderValue, ctrl);
        ctrl.sliderValue = quantized;
        if (betSlider && !betSlider.disabled) {
            betSlider.value = String(quantized);
        }
        if (betAmountInput && !betAmountInput.disabled) {
            betAmountInput.value = String(quantized);
        }
        updateBetButtonDisplay();
    };

    async function sendPlayerAction(action, amount = 0) {
        if (!currentGame.tableId || !currentGame.myDocId) {
            console.warn('Ignoring action without active player context', { action });
            return;
        }
        if (actionInFlight) return;
        actionInFlight = true;
        try {
            await playerAction(currentGame.tableId, currentGame.myDocId, action, Math.max(0, Math.round(amount || 0)));
        } catch (err) {
            console.error('playerAction failed', action, err);
            const msg = err?.message || `Action "${action}" failed.`;
            setMessage(msg);
        } finally {
            actionInFlight = false;
        }
    }

    if (betSlider) {
        betSlider.addEventListener('input', () => {
            if (betSlider.disabled) return;
            syncBetSlider(betSlider.value);
        });
        betSlider.addEventListener('change', () => {
            if (betSlider.disabled) return;
            syncBetSlider(betSlider.value);
        });
    }

    if (betAmountInput) {
        const handleAmountInput = () => {
            if (betAmountInput.disabled) return;
            syncBetSlider(betAmountInput.value);
        };
        betAmountInput.addEventListener('input', handleAmountInput);
        betAmountInput.addEventListener('change', handleAmountInput);
    }

    if (Array.isArray(betPresetButtons) && betPresetButtons.length) {
        betPresetButtons.forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                const ctrl = currentGame.control;
                if (!ctrl || !ctrl.canAct || ctrl.sliderMax <= 0) return;
                const ratio = Number(btn.dataset?.preset || 0);
                if (!Number.isFinite(ratio) || ratio <= 0) {
                    syncBetSlider(ctrl.sliderMin || ctrl.sliderValue || 0);
                    return;
                }
                const span = Math.max(0, (ctrl.sliderMax || 0) - (ctrl.sliderMin || 0));
                let target;
                if (ratio >= 1) {
                    target = ctrl.sliderMax;
                } else {
                    target = (ctrl.sliderMin || 0) + span * ratio;
                }
                syncBetSlider(target);
            });
        });
    }

    if (foldBtn) {
        foldBtn.addEventListener('click', async () => {
            if (!currentGame.control?.canAct) return;
            await sendPlayerAction('fold');
        });
    }

    if (checkBtn) {
        checkBtn.addEventListener('click', async () => {
            const ctrl = currentGame.control;
            if (!ctrl?.canAct || (ctrl.toCall || 0) !== 0) return;
            await sendPlayerAction('check');
        });
    }

    if (callBtn) {
        callBtn.addEventListener('click', async () => {
            const ctrl = currentGame.control;
            if (!ctrl?.canAct || (ctrl.toCall || 0) <= 0) return;
            await sendPlayerAction('call');
        });
    }

    if (betBtn) {
        betBtn.addEventListener('click', async () => {
            const ctrl = currentGame.control;
            if (!ctrl?.canAct) return;
            if (ctrl.sliderMax <= 0) return;
            syncBetSlider(betSlider && !betSlider.disabled ? betSlider.value : ctrl.sliderValue);
            const amount = ctrl.sliderValue || ctrl.sliderMin || 0;
            if (amount <= 0) return;
            const action = ctrl.actionType === 'bet' ? 'bet' : 'raise';
            await sendPlayerAction(action, amount);
        });
    }

    if (allInBtn) {
        allInBtn.addEventListener('click', async () => {
            const state = currentGame.lastState;
            const ctrl = currentGame.control;
            if (!ctrl?.canAct || !state) return;
            const myId = currentGame.myDocId;
            const me = myId ? state.players?.[myId] : null;
            if (!me) return;
            const stack = Math.max(0, me.stack || 0);
            const toCall = Math.max(0, ctrl.toCall || 0);
            if (stack <= 0) return;
            if (toCall >= stack) {
                await sendPlayerAction('call');
                return;
            }
            if (toCall === 0) {
                await sendPlayerAction('bet', stack);
            } else {
                await sendPlayerAction('raise', Math.max(0, stack - toCall));
            }
        });
    }
    function showMainMenu(messageOverride) {
        cleanupRealtime();
        hideAiResultOverlay();
        hideAllPanels();
        clearInlineClaimFeedback();
        
        // Počisti activeGame iz localStorage ko se vrneš v meni
        try {
            localStorage.removeItem('activeGame');
        } catch (e) {
            console.warn('Failed to clear activeGame from localStorage:', e);
        }
        
        if (postLoginMenu) postLoginMenu.style.display = 'flex';
        if (backToMenuBtn) backToMenuBtn.style.display = 'none';
        if (startGameBtn) startGameBtn.style.display = 'none';
        const menuMessage = messageOverride || 'Welcome to Universal Poker. What would you like to do?';
        setMessage(menuMessage);
        setMode('menu');
        refreshWbstrSummary().catch(() => {});
    }
    function openPanel(name) {
        cleanupRealtime();
        if (postLoginMenu) postLoginMenu.style.display = 'none';
        hideAllPanels();
        if (backToMenuBtn) backToMenuBtn.style.display = 'inline-block';
        document.body.classList.toggle('has-setup', name.startsWith('organize'));
        if (name === 'organize' || name === 'organize-cash' || name === 'organize-sng' || name === 'organize-scheduled') {
            if (setupPanel) { setupPanel.style.display = 'block'; loadSetupIntoInputs(); setTimeout(validateSetupForm, 50); }
            const sel = document.getElementById('setup-gametype');
            if (sel) { sel.value = (name === 'organize-sng') ? 'sng' : (name === 'organize-scheduled' ? 'scheduled' : 'cash'); sel.dispatchEvent(new Event('change', { bubbles: true })); }
            return;
        }
        if (name === 'ai' && panelAI) { 
            document.body.classList.remove('has-setup'); 
            panelAI.style.display = 'block'; 
            // Re-enable Start PC game button when returning to AI panel
            const startAiBtn = document.getElementById('btn-start-ai');
            if (startAiBtn) {
                startAiBtn.disabled = false;
                startAiBtn.textContent = 'Start PC game (WBSTR)';
            }
            return; 
        }
        if (name === 'join' && panelJoin) { document.body.classList.remove('has-setup'); panelJoin.style.display = 'block'; startJoinRealtime(); return; }
        if (name === 'boards' && panelBoards) { document.body.classList.remove('has-setup'); panelBoards.style.display = 'block'; startBoardsRealtime(); return; }
        if (name === 'help' && panelHelp) { document.body.classList.remove('has-setup'); panelHelp.style.display = 'block'; return; }
    }

    // --- IZBOLJŠANO ---: Učinkovitejše osveževanje seznama miz in čistejša koda
    function startJoinRealtime() {
        cleanupRealtime();
        if (publicTablesEl) publicTablesEl.innerHTML = 'Connecting…';
        try {
            const filterSel = document.getElementById('join-filter-type');
            const seatCounts = {};
            let lastWaiting = [];
            let lastActive = [];

            const renderLists = () => {
                if (!publicTablesEl) return;

                const waitingHtml = lastWaiting.length ? lastWaiting.map(t => {
                    const tokenLbl = t.tokenAddress === ZERO_ADDRESS ? 'LYX' : 'WBSTR';
                    const title = String(t.name || '').trim() || t.id;
                    const ttype = t.type || 'cash';
                    const typeLbl = ttype === 'sng' ? 'SNG' : (ttype === 'scheduled' ? 'Scheduled' : 'Cash');
                    const cur = Number(t.players || 0);
                    const cap = Math.max(2, Math.min(9, Number(t.maxPlayers || 9)));
                    const isFull = cur >= cap;
                    const badge = isFull ? `<span class="badge full">Full</span>` : `<span class="badge seats">${cur}/${cap} seats</span>`;
                    const buyinLbl = t.buyin ? ` • Buy-in: ${t.buyin}` : '';
                    const minLbl = (typeof t.minChips === 'number' && t.minChips > 0) ? ` • Min: ${t.minChips} chips` : '';
                    let startLbl = '';
                    if (t.startAt) {
                        const d = new Date(t.startAt);
                        startLbl = ` • Start: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                    }
                    return `
                        <div class="list-item" data-type="${ttype}" data-state="waiting">
                            <div>
                                <b>${title}</b> <span class="hint">(${t.host || 'Host'})</span> • ${typeLbl} • ${t.sb}/${t.bb} • stack ${t.stack} • ${tokenLbl}${buyinLbl}${minLbl}${startLbl} ${badge}
                            </div>
                            <div>
                                <button data-join="${t.id}" class="control-btn" ${isFull ? 'disabled' : ''}>Join</button>
                            </div>
                        </div>`;
                }).join('') : '<div class="hint">No open tables.</div>';

                const activeHtml = lastActive.length ? lastActive.map(t => {
                    if (t.type !== 'cash') return '';
                    const title = String(t.name || '').trim() || t.id;
                    const cap = Math.max(2, Math.min(9, Number(t.maxPlayers || 9)));
                    const cur = seatCounts[t.id];
                    const isFull = typeof cur === 'number' ? (cur >= cap) : false;
                    const badge = typeof cur === 'number' 
                        ? (isFull ? `<span class="badge full">Full</span>` : `<span class="badge seats">${cur}/${cap} seats</span>`) 
                        : `<span class="badge seats">Seats: ?/${cap}</span>`;
                    const minLbl = (typeof t.minChips === 'number' && t.minChips > 0) ? ` • Min: ${t.minChips} chips` : '';
                    return `
                        <div class="list-item" data-type="cash" data-state="active">
                            <div>
                                <b>${title}</b> <span class="hint">(${t.host || 'Host'})</span> • Active • ${t.sb}/${t.bb} • stack ${t.stack}${minLbl} ${badge}
                            </div>
                            <div>
                                <button data-join-active="${t.id}" class="control-btn" ${isFull ? 'disabled' : ''}>Join mid-hand</button>
                            </div>
                        </div>`;
                }).join('') : '<div class="hint">No active cash tables.</div>';

                publicTablesEl.innerHTML = `
                    <div class="panel">
                        <div class="panel-title">Open tables (waiting)</div>
                        ${waitingHtml}
                    </div>
                    <div class="panel" style="margin-top:8px">
                        <div class="panel-title">Active cash tables (join mid-hand)</div>
                        ${activeHtml}
                    </div>`;
                
                if (filterSel) {
                    const type = filterSel.value || 'all';
                    document.querySelectorAll('#public-tables .list-item').forEach(div => {
                        const dt = div.getAttribute('data-type') || 'cash';
                        div.style.display = (type === 'all' || type === dt) ? '' : 'none';
                    });
                }
            };

            const applyFilter = () => renderLists();
            if (filterSel) filterSel.addEventListener('change', applyFilter);
            
            unsub.tables = subscribeOpenTables((list) => { 
                lastWaiting = (list || []).filter(t => !t.isPrivate && String(t.mode || '') !== 'ai'); 
                renderLists(); 
            });

            unsub.active = subscribeActiveTables(async (list) => {
                lastActive = (list || []).filter(t => t.type === 'cash' && !t.isPrivate && String(t.mode || '') !== 'ai');
                
                // Zberemo vse obljube (promises) za pridobivanje števila igralcev
                const playerCountsPromises = lastActive.map(t => 
                    listTablePlayers(t.id, 100).then(arr => {
                        const count = Array.isArray(arr) ? arr.filter(p => ['seated','playing','active'].includes(p.status)).length : 0;
                        return { tableId: t.id, count };
                    }).catch(() => ({ tableId: t.id, count: NaN })) // V primeru napake
                );

                // Wait for all requests to complete
                const results = await Promise.all(playerCountsPromises);
                
                // Update seat counts all at once
                results.forEach(result => {
                    seatCounts[result.tableId] = result.count;
                });

                // Seznam renderiramo samo enkrat po vseh posodobitvah
                renderLists();
            });

            if (publicTablesEl) publicTablesEl.addEventListener('click', async (ev) => {
                const btn = ev.target.closest('button[data-join], button[data-join-active]'); 
                if (!btn) return;
                const tableId = btn.getAttribute('data-join') || btn.getAttribute('data-join-active');
                try {
                    const t = await getTable(tableId); 
                    if (!t) throw new Error('Table not found');
                    const me = await addPlayerToTable(tableId, { name: (window.__upUsername || 'Player'), address: (window.__upAddress || null), role: 'player' });
                    enterWaitingRoom(tableId, me.id, false);
                } catch (e) { 
                    setMessage(e?.message || String(e)); 
                }
            });
        } catch (e) { 
            if (publicTablesEl) publicTablesEl.innerHTML = `<div class="error">Error: ${e.message || e}</div>`; 
        }
    }

    // === NEW Play vs PC Leaderboards ===
    async function startBoardsRealtime() {
        cleanupRealtime();
        
        const renderLeaderboard = (rows) => {
            if (!leaderboardList || !leaderboardLoading || !leaderboardEmpty) return;
            
            // Hide loading, show content
            leaderboardLoading.style.display = 'none';
            
            if (!rows || rows.length === 0) {
                leaderboardList.style.display = 'none';
                leaderboardEmpty.style.display = 'block';
                return;
            }
            
            leaderboardEmpty.style.display = 'none';
            leaderboardList.style.display = 'block';
            
            const category = boardCategorySelect?.value || 'wins';
            const categoryLabels = {
                'wins': '🏅 Wins',
                'rewards': '💰 Rewards (chips)',
                'volume': '📊 Volume (chips)',
                'games': '🎮 Games'
            };
            
            const categoryFields = {
                'wins': 'wins',
                'rewards': 'totalRewards',
                'volume': 'totalVolume',
                'games': 'gamesPlayed'
            };
            
            const label = categoryLabels[category] || 'Score';
            const field = categoryFields[category] || 'wins';
            
            const html = rows.map((player, index) => {
                const rank = index + 1;
                const name = player.displayName || `Player ${player.address.substring(0, 8)}...`;
                const value = player[field] || 0;
                const wins = player.wins || 0;
                const losses = player.losses || 0;
                const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';
                
                // Medal for top 3
                let medal = '';
                if (rank === 1) medal = '🥇';
                else if (rank === 2) medal = '🥈';
                else if (rank === 3) medal = '🥉';
                
                return `
                    <div class="leaderboard-row" style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; margin-bottom: 0.5rem; background: #2a2a2a; border-radius: 4px;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex: 1;">
                            <div style="font-size: 1.2em; font-weight: bold; min-width: 2.5rem;">${medal} #${rank}</div>
                            <div style="flex: 1;">
                                <div style="font-weight: bold; color: #fff;">${name}</div>
                                <div style="font-size: 0.85em; color: #888;">
                                    ${wins}W - ${losses}L (${winRate}% win rate)
                                </div>
                            </div>
                        </div>
                        <div style="text-align: right; font-weight: bold; color: #4CAF50; font-size: 1.1em;">
                            ${value.toLocaleString()}
                        </div>
                    </div>
                `;
            }).join('');
            
            leaderboardList.innerHTML = html;
        };
        
        const wire = () => {
            cleanupRealtime();
            if (!boardCategorySelect) return;
            
            // Show loading state
            if (leaderboardLoading) leaderboardLoading.style.display = 'block';
            if (leaderboardList) leaderboardList.style.display = 'none';
            if (leaderboardEmpty) leaderboardEmpty.style.display = 'none';
            
            const category = boardCategorySelect.value || 'wins';
            unsub.boards = subscribePlayerStatsByCategory(category, renderLeaderboard, 20);
        };
        
        if (boardCategorySelect) boardCategorySelect.onchange = wire;
        if (refreshBoardsBtn) refreshBoardsBtn.onclick = wire;
        wire();
    }

    // Helper: load setup panel defaults and bind create
    function loadSetupIntoInputs() {
        if (!setupPanel) return;
        const typeSel = setupGameType;
        const startRow = setupStartRow;
        const updateVis = () => {
            const typeVal = (typeSel?.value || 'cash');
            if (startRow) startRow.style.display = (typeVal === 'scheduled') ? '' : 'none';
            if (tzHintEl) {
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                tzHintEl.textContent = `Your timezone: ${tz}`;
            }
        };
        if (typeSel) typeSel.onchange = updateVis;
        updateVis();
        // Bind create
        const createBtn = document.getElementById('btn-create-table');
        if (createBtn) createBtn.onclick = async () => {
            try {
                validateSetupForm();
                if (createBtn.disabled) return;
                createTableResult.textContent = 'Creating…';
                const hostName = setupName?.value?.trim() || 'UP Host';
                const typeVal = (setupGameType?.value || 'cash');
                let startAt = null;
                if (typeVal === 'scheduled') {
                    const d = setupDate?.value || '';
                    const t = setupTime?.value || '';
                    if (!d || !t) throw new Error('Please set date and time');
                    const [yy, mm, dd] = d.split('-').map(n=>parseInt(n,10));
                    const [hh, mi] = t.split(':').map(n=>parseInt(n,10));
                    startAt = new Date(yy, (mm-1), dd, hh||0, mi||0, 0, 0).toISOString();
                }
                const maxPlayers = Math.max(2, Math.min(9, Number(setupPlayers?.value||4)));
                const payload = {
                    name: hostName,
                    host: window.__upUsername || 'UP',
                    hostId: (window.__upAddress || 'unknown').toLowerCase(),
                    maxPlayers,
                    sb: Number(setupSB?.value||10),
                    bb: Number(setupBB?.value||20),
                    stack: Number(setupStack?.value||1000),
                    tokenAddress: (setupToken?.value === 'LYX') ? ZERO_ADDRESS : WBSTR_TOKEN_ADDRESS,
                    unitMultiplier: undefined,
                    isPrivate: false,
                    mode: 'public',
                    buyin: Number(setupBuyin?.value||0),
                    minChips: Number(setupMinChips?.value||0),
                    type: typeVal,
                    startAt,
                };
                const created = await createTable(payload);
                let me = null;
                try { me = await joinOnCreate(created.id, { name: window.__upUsername || 'Host', address: window.__upAddress || null }); } catch (_) {}
                createTableResult.textContent = `Table created: ${created.id}`;
                enterWaitingRoom(created.id, me?.id || null, true);
            } catch (e) {
                createTableResult.textContent = e?.message || String(e);
            }
        };
    }

    // Waiting room implementation
    function enterWaitingRoom(tableId, myDocId, isHost) {
        currentWaiting = { tableId, myDocId, isHost: !!isHost, mode: null, lastStatus: null, enteredGame: false };
        hideAllPanels();
        if (panelWaiting) panelWaiting.style.display = 'block';
        // Render header/meta
        if (waitingTableTitleEl) waitingTableTitleEl.textContent = tableId;
        if (waitingTableMetaEl) waitingTableMetaEl.textContent = 'Loading…';

        // Subscribe to table doc
        try { unsub.tableDoc = subscribeTable(tableId, (t) => {
            if (!t) return;
            if (currentWaiting.tableId === tableId) {
                currentWaiting.mode = t.mode || currentWaiting.mode || null;
            }
            if (waitingTableTitleEl) waitingTableTitleEl.textContent = t.name || tableId;
            const cap = Math.max(2, Math.min(9, Number(t.maxPlayers||9)));
            const typeLbl = t.type === 'sng' ? 'SNG' : (t.type === 'scheduled' ? 'Scheduled' : 'Cash');
            const buyinLbl = t.buyin ? ` • Buy-in: ${t.buyin}` : '';
            const minLbl = (typeof t.minChips === 'number' && t.minChips>0) ? ` • Min: ${t.minChips} chips` : '';
            let startLbl = '';
            if (t.startAt) { const d = new Date(t.startAt); startLbl = ` • Start: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`; }
            const statusLower = String(t.status || '').toLowerCase();
            const statusLbl = statusLower ? ` • status: ${statusLower}` : '';
            const autoStart = String(t.mode || '').toLowerCase() === 'ai';
            const autoLbl = autoStart ? ' • AI auto-start' : '';
            if (waitingTableMetaEl) {
                waitingTableMetaEl.textContent = `${typeLbl} • ${t.sb}/${t.bb} • stack ${t.stack}${buyinLbl}${minLbl}${startLbl} • ${t.players||0}/${cap} players${statusLbl}${autoLbl}`;
            }

            if (startTableBtn) {
                if (autoStart) {
                    startTableBtn.style.display = 'none';
                    startTableBtn.disabled = true;
                } else {
                    const showForHost = !!currentWaiting.isHost;
                    startTableBtn.style.display = showForHost ? 'inline-block' : 'none';
                    startTableBtn.disabled = !showForHost;
                }
            }

            const previousStatus = currentWaiting.lastStatus;
            if (currentWaiting.tableId === tableId) {
                currentWaiting.lastStatus = statusLower;
            }

            if (autoStart && currentWaiting.tableId === tableId && previousStatus !== statusLower) {
                if (statusLower === 'starting') {
                    setMessage('Buy-in confirmed. Your Play vs PC match will launch automatically in a few seconds.');
                }
                if (statusLower === 'active') {
                    setMessage('Game is live! Taking you to the table…');
                }
            }

            // Transition to game when table becomes active
            if (statusLower === 'active' && currentWaiting.tableId === tableId && !currentWaiting.enteredGame) {
                currentWaiting.enteredGame = true;
                const isAiMode = String(currentWaiting.mode || '').toLowerCase() === 'ai';
                enterGame(tableId, myDocId, { isAi: isAiMode });
            }
        }); } catch (_) {}

        // Subscribe to players list
        try { unsub.waitingPlayers = subscribeTablePlayers(tableId, async (rows) => {
            if (!waitingPlayersEl) return;
            const cap = Math.max(2, Math.min(9, rows?.cap || 9));
            // Render players with avatars
            const html = await Promise.all((rows||[]).map(async (p) => {
                const img = await fetchAvatarForAddress(p.address || '');
                const role = p.role === 'host' ? 'Host' : (p.role === 'bot' ? 'Bot' : 'Player');
                const you = (p.id === myDocId) ? ' • you' : '';
                const av = img ? `<img src="${img}" alt="" width="20" height="20" style="border-radius:50%;margin-right:6px;" />` : '';
                return `<div class="list-item"><div style="display:flex;align-items:center;gap:6px;">${av}<b>${p.name||'Player'}</b><span class="hint">(${role}${you})</span></div><div>${p.status||''}</div></div>`;
            }));
            waitingPlayersEl.innerHTML = html.join('');
            if (startTableBtn) {
                const autoStart = String(currentWaiting.mode || '').toLowerCase() === 'ai';
                if (autoStart) {
                    startTableBtn.style.display = 'none';
                    startTableBtn.disabled = true;
                } else {
                    startTableBtn.style.display = isHost ? 'inline-block' : 'none';
                    startTableBtn.disabled = !isHost;
                }
            }
        }); } catch (_) {}

        // Chat subscription
        try { unsub.chat = subscribeTableChat(tableId, (msgs) => {
            if (!waitingChatEl) return;
            waitingChatEl.innerHTML = (msgs||[]).map(m => {
                const who = m.author || (m.address ? m.address.slice(0,6)+'…'+m.address.slice(-4) : '—');
                const when = m.createdAt?.toDate ? m.createdAt.toDate().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
                return `<div class="chat-msg"><span class="hint">${when}</span> <b>${who}:</b> ${m.text||''}</div>`;
            }).join('');
            waitingChatEl.scrollTop = waitingChatEl.scrollHeight;
        }); } catch (_) {}

        // Bind actions
        if (chatSendBtn) chatSendBtn.onclick = async () => {
            const txt = chatInput?.value?.trim();
            if (!txt) return;
            chatInput.value = '';
            try { await addChatMessage(tableId, { author: window.__upUsername || 'Player', address: window.__upAddress || null, text: txt }); } catch (e) { /* ignore */ }
        };
        if (startTableBtn) startTableBtn.onclick = async () => {
            const autoStart = String(currentWaiting.mode || '').toLowerCase() === 'ai';
            if (autoStart) {
                setMessage('This Play vs PC table launches automatically once the buy-in clears. Thanks for your patience.');
                return;
            }
            try { await startTable(tableId); } catch (e) { alert(e?.message || String(e)); }
        };
        if (leaveWaitingBtn) leaveWaitingBtn.onclick = async () => {
            try { if (myDocId) await removePlayerFromTable(tableId, myDocId); } catch (_) {}
            showMainMenu();
        };
    }

    // Leaderboards wired above
    // Join by ID
    if (joinTableBtn) joinTableBtn.onclick = async () => {
        const tableId = (joinTableIdInput?.value || '').trim();
        if (!tableId) return;
        try { const t = await getTable(tableId); if (!t) throw new Error('Table not found'); const me = await addPlayerToTable(tableId, { name: window.__upUsername || 'Player', address: window.__upAddress || null, role: 'player' }); enterWaitingRoom(tableId, me.id, false); }
        catch (e) { setMessage(e?.message || String(e)); }
    };
    if (refreshTablesBtn) refreshTablesBtn.onclick = () => startJoinRealtime();

    // AI: simple create private table with bots
    const aiBotsInput = document.getElementById('ai-bots');
    const aiSbInput = document.getElementById('ai-sb');
    const aiBbInput = document.getElementById('ai-bb');
    const aiTokenLabel = document.getElementById('ai-token-label');
    const aiWbstrHint = document.getElementById('ai-wbstr-hint');
    const aiStackHint = document.getElementById('ai-stack-hint');
    
    const updateAiDerived = () => {
        const diff = String(aiDifficultyEl?.value || 'easy');
        const maxStackByDifficulty = { 'easy': 500, 'medium': 750, 'hard': 1000 };
        const maxStack = maxStackByDifficulty[diff] || 1000;
        
        let stack = Number(aiStackEl?.value || 100);
        
        // Only clamp if we're actually validating (on blur/change, not on every keystroke)
        // This allows user to type freely
        
        // Update hint text with minimum warning
        if (aiStackHint) {
            if (stack < 100 && stack > 0) {
                aiStackHint.textContent = `⚠️ Minimum 100 chips required! ${diff.charAt(0).toUpperCase() + diff.slice(1)}: 100-${maxStack} chips`;
                aiStackHint.style.color = '#ff6b6b';
            } else if (stack > maxStack) {
                aiStackHint.textContent = `⚠️ Maximum ${maxStack} chips for ${diff}! ${diff.charAt(0).toUpperCase() + diff.slice(1)}: 100-${maxStack} chips`;
                aiStackHint.style.color = '#ff6b6b';
            } else {
                aiStackHint.textContent = `${diff.charAt(0).toUpperCase() + diff.slice(1)}: 100-${maxStack} chips`;
                aiStackHint.style.color = '#888';
            }
        }
        
        // Use valid stack for calculations (clamp for display purposes only)
        const validStack = Math.max(100, Math.min(maxStack, stack));
        
        // Tournament blind levels - always start at level 0 (SB=5, BB=10)
        const sb = 5;
        const bb = 10;
        if (aiSbInput) aiSbInput.value = String(sb);
        if (aiBbInput) aiBbInput.value = String(bb);
        const bots = diff === 'hard' ? 6 : diff === 'medium' ? 4 : 2;
        if (aiBotsInput) aiBotsInput.value = String(bots);
        if (aiPotentialRewardEl) {
            const buyin = validStack;
            const mult = diff === 'hard' ? 2.1 : diff === 'medium' ? 1.45 : 1.2;
            aiPotentialRewardEl.textContent = `Potential reward: ~${Math.round(buyin * (mult - 1))} chips`;
        }
        if (aiWbstrHint) {
            const buyin = validStack;
            const wbstrRequired = buyin * WBSTR_PER_CHIP;
            const buyinFormatted = formatNumber(buyin, { fractionDigits: 0 });
            const wbstrFormatted = formatNumber(wbstrRequired, { fractionDigits: 2 });
            aiWbstrHint.textContent = `${buyinFormatted} chips ≈ ${wbstrFormatted} WBSTR (1 chip = 1000 WBSTR). Starting blinds: ${sb}/${bb}`;
        }
    };
    
    // Clamp value only when user finishes editing
    const clampAiStack = () => {
        const diff = String(aiDifficultyEl?.value || 'easy');
        const maxStackByDifficulty = { 'easy': 500, 'medium': 750, 'hard': 1000 };
        const maxStack = maxStackByDifficulty[diff] || 1000;
        
        if (aiStackEl) {
            let stack = Number(aiStackEl.value || 100);
            if (stack < 100) {
                aiStackEl.value = '100';
            } else if (stack > maxStack) {
                aiStackEl.value = String(maxStack);
            }
            updateAiDerived();
        }
    };
    
    if (aiTokenLabel) aiTokenLabel.textContent = 'WBSTR only (LSP7)';
    if (aiDifficultyEl) {
        aiDifficultyEl.onchange = () => {
            clampAiStack(); // Re-clamp when difficulty changes
        };
    }
    if (aiStackEl) {
        aiStackEl.oninput = updateAiDerived; // Update hints as user types
        aiStackEl.onblur = clampAiStack; // Clamp only when field loses focus
        aiStackEl.onchange = clampAiStack; // Or when user presses Enter
    }
    updateAiDerived();
    
    // AI error message element
    const aiErrorMessageEl = document.getElementById('ai-error-message');
    const showAiError = (msg) => {
        if (aiErrorMessageEl) {
            aiErrorMessageEl.textContent = msg || '';
            aiErrorMessageEl.style.display = msg ? 'block' : 'none';
        }
    };
    const hideAiError = () => {
        if (aiErrorMessageEl) {
            aiErrorMessageEl.textContent = '';
            aiErrorMessageEl.style.display = 'none';
        }
    };
    
    const startAiBtn = document.getElementById('btn-start-ai');
    if (startAiBtn) startAiBtn.onclick = async () => {
        hideAiError(); // Clear previous errors
        
        // Disable button to prevent multiple clicks
        if (startAiBtn.disabled) return;
        startAiBtn.disabled = true;
        const originalText = startAiBtn.textContent;
        startAiBtn.textContent = 'Starting...';
        
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('Wallet not connected. Please connect your Universal Profile first.');
            const addr = (await signer.getAddress()).toLowerCase();
            const name = window.__upUsername || 'UP';
            const bots = Number(aiBotsInput?.value || 2);
            const sb = Number(aiSbInput?.value || 10);
            const bb = Number(aiBbInput?.value || 20);
            const stack = Number(aiStackEl?.value || 1000);
            const difficulty = String(aiDifficultyEl?.value || 'easy');
            
            // Validate stack limits based on difficulty
            const MIN_STACK = 100;
            const maxStackByDifficulty = {
                'easy': 500,
                'medium': 750,
                'hard': 1000
            };
            const maxStack = maxStackByDifficulty[difficulty] || 1000;
            
            if (stack < MIN_STACK) {
                throw new Error(`Minimum starting stack is ${MIN_STACK} chips for all difficulties.`);
            }
            if (stack > maxStack) {
                throw new Error(`Maximum starting stack for ${difficulty} difficulty is ${maxStack} chips.`);
            }
            
            // For the AI flow we treat the stack as the chip-denominated buy-in
            const buyin = stack;
            const wbstrRequired = buyin * WBSTR_PER_CHIP;
            const buyinFormatted = formatNumber(buyin, { fractionDigits: 0 });
            const wbstrFormatted = formatNumber(wbstrRequired, { fractionDigits: 2 });
            const perChipFormatted = formatNumber(WBSTR_PER_CHIP, { fractionDigits: 0 });
            setMessage(`Setting up your Play vs PC match… Buy-in ${buyinFormatted} chips ≈ ${wbstrFormatted} WBSTR (1 chip = ${perChipFormatted} WBSTR).`);

            // 1) Create the AI table on the backend
            const created = await startAiGameCreate({ difficulty, buyin, tokenAddress: WBSTR_TOKEN_ADDRESS, unitMultiplier: undefined, hostAddress: addr, hostName: name, bots, sb, bb });
            const tableId = created.tableId || created.id;
            if (!tableId) throw new Error('Unable to create AI table.');
            const unitMult = created.unitMultiplier;

            // 2) Authorise operator + deposit via GameEntry (buyInLSP7)
            let permissionFixApplied = false;
            setMessage('Checking WBSTR permissions and preparing your buy-in…');
            const depositResult = await depositWbstr(
                tableId,
                buyin,
                unitMult,
                WBSTR_TOKEN_ADDRESS,
                10n,
                {
                    onStatus: (status) => {
                        switch (status) {
                            case 'checking-permissions':
                                setMessage('Checking WBSTR allowances before the buy-in…');
                                break;
                            case 'already-authorized':
                                setMessage('Permissions already set. Proceeding with the WBSTR buy-in…');
                                break;
                            case 'authorize-operator':
                                setMessage(`Please approve the WBSTR spending request in your wallet (up to ${wbstrFormatted} WBSTR).`);
                                break;
                            case 'permission-fix-start':
                                setMessage('Your profile needs a one-time permission update. Approve the request in the Lukso extension.');
                                break;
                            case 'permission-fix-applied':
                                permissionFixApplied = true;
                                setMessage('Permissions updated successfully. Continuing with the WBSTR buy-in…');
                                break;
                            case 'operator-authorized':
                                setMessage('Spending permission confirmed. Initiating the WBSTR buy-in…');
                                break;
                            case 'depositing':
                                setMessage(`WBSTR buy-in pending. Approve approximately ${wbstrFormatted} WBSTR in your wallet to continue.`);
                                break;
                            default:
                                break;
                        }
                    }
                }
            );
            if (permissionFixApplied) {
                setMessage('Permission update confirmed. Finalizing the WBSTR buy-in with the server…');
            } else {
                setMessage('WBSTR buy-in confirmed on-chain. Finalizing with the server…');
            }
            const receipt = depositResult?.receipt || depositResult;
            const txHash = receipt?.hash || receipt?.transactionHash || null;
            if (!txHash) {
                throw new Error('Unable to read the transaction hash for the buy-in.');
            }

            // 3) Confirm on the backend and enter the waiting room
            setMessage('Confirming your buy-in on the server…');
            try {
                await startAiGameConfirm({ tableId, txHash, hostAddress: addr, buyin });
                setMessage('Buy-in verified! Loading your table now…');
            } catch (confirmErr) {
                const friendly = translateAiErrorMessage(confirmErr?.message || String(confirmErr));
                setMessage(friendly);
                if (friendly.toLowerCase().includes('not enough wbstr')) {
                    flashHint(aiWbstrHint);
                }
                console.error('AI buy-in confirmation failed:', confirmErr);
                // Re-enable button on confirmation error
                startAiBtn.disabled = false;
                startAiBtn.textContent = originalText;
                return;
            }
            const hostPid = created.hostPlayerId || null;
            enterGame(tableId, hostPid, { isAi: true });
            // Success - button will stay disabled since user is now in game
        } catch (e) {
            const rawMessage = e?.message || String(e);
            const msg = translateAiErrorMessage(rawMessage);
            showAiError(msg); // Show error in AI panel
            setMessage(msg); // Also show in game area if visible
            if (msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('not enough')) {
                flashHint(aiWbstrHint);
            }
            console.error('Failed to start Play vs PC game:', e);
            // Re-enable button on error
            startAiBtn.disabled = false;
            startAiBtn.textContent = originalText;
        }
    };

    // Minimal in-game view: subscribe and switch layout
    function enterGame(tableId, myDocId, options = {}) {
        clearGameEndTimer();
        hideAllPanels();
        if (postLoginMenu) postLoginMenu.style.display = 'none';
        if (backToMenuBtn) backToMenuBtn.style.display = 'inline-block';
        if (tableAreaEl) tableAreaEl.classList.remove('is-hidden');
        setMode('game');
        const isAiTable = options?.isAi === true;
        currentGame = {
            tableId,
            myDocId: myDocId || null,
            lastState: null,
            control: null,
            phaseCue: null,
            bets: {},
            ended: false,
            isAiTable,
            endTimeout: null,
            pendingConclusion: null
        };
        
        // Shrani aktivno igro v localStorage za reconnect
        try {
            localStorage.setItem('activeGame', JSON.stringify({
                tableId,
                myDocId,
                isAiTable,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn('Failed to save active game to localStorage:', e);
        }
        
        currentWaiting.enteredGame = true;
        try { unsub.tableDoc && unsub.tableDoc(); } catch (_) {}
        if (isAiTable) {
            unsub.tableDoc = subscribeTable(tableId, (tableDoc) => {
                if (!tableDoc || !currentGame || currentGame.ended) return;
                const resultField = tableDoc.aiMatchResult;
                if (!resultField) return;
                // New logic: Check autoWithdrawStatus for definitive win/loss state
                const withdrawStatus = (resultField.autoWithdrawStatus || '').toLowerCase();
                
                if (withdrawStatus === 'pending') {
                    scheduleAiConclusion('win', { tableDoc });
                } else if (['collecting_loss', 'collected_loss', 'failed_collection', 'lost'].includes(withdrawStatus)) {
                    scheduleAiConclusion('loss', { tableDoc });
                }
            });
        } else {
            unsub.tableDoc = null;
        }
        updateGameView(null);
    setMessage('Connecting to the table…');
        try { unsub.game && unsub.game(); } catch (_) {}
        unsub.game = subscribeGameState(tableId, (state) => {
            updateGameView(state || null);
        });
    }

    if (connectButton) {
        connectButton.onclick = () => {
            displayAccountPicker({ requestPermission: true });
        };
    }
    if (accountContinueBtn) {
        accountContinueBtn.onclick = async () => {
            if (!selectedAccount) return;
            const previous = accountContinueBtn.textContent;
            accountContinueBtn.disabled = true;
            accountContinueBtn.textContent = 'Connecting…';
            try {
                await completeLogin(selectedAccount);
            } catch (err) {
                if (errorMessage) errorMessage.textContent = err?.message || 'Unable to complete login. Please try again.';
            } finally {
                if (accountPicker && accountPicker.style.display === 'none') {
                    return;
                }
                accountContinueBtn.disabled = false;
                accountContinueBtn.textContent = previous;
            }
        };
    }
    if (logoutBtn) logoutBtn.onclick = () => { try { window.location.reload(); } catch (_) { /* noop */ } };
    if (toggleProfileBtn) toggleProfileBtn.onclick = () => { toggleProfilePopup(); };
    if (inlineClaimBtn) {
        inlineClaimBtn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await handleClaimRewards({ source: 'inline' });
        });
    }
    if (menuClaimBtn) {
        console.log('✅ Claim button found and listener attached');
        menuClaimBtn.addEventListener('click', async (ev) => {
            console.log('🔥 CLAIM BUTTON CLICKED!');
            ev.preventDefault();
            await handleClaimAll({ source: 'menu' });
        });
    } else {
        console.error('❌ menuClaimBtn element NOT FOUND');
    }

    // BUY WBSTR button - open Universal.Page swap
    const buyWbstrBtn = document.getElementById('btn-buy-wbstr');
    if (buyWbstrBtn) {
        buyWbstrBtn.addEventListener('click', () => {
            const wbstrAddress = WBSTR_TOKEN_ADDRESS || '0xce66c55a5a3d6a7c0665f4c31a81ba51b24b4143';
            const swapUrl = `https://universalswaps.io/swap?inputCurrency=0x2db41674f2b882889e5e1bd09a3f3613952bc472&outputCurrency=${wbstrAddress}`;
            window.open(swapUrl, '_blank', 'noopener,noreferrer');
        });
    }

    // Menu routing
    document.querySelectorAll('#postlogin-menu .menu-btn').forEach(btn => {
        btn.addEventListener('click', () => { const t = btn.getAttribute('data-target'); if (t) openPanel(t); });
    });
    
    // Panel back buttons - return to main menu
    document.querySelectorAll('.panel-back-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-back-to');
            if (target === 'main-menu') {
                showMainMenu();
            }
        });
    });
    
    if (backToMenuBtn) backToMenuBtn.onclick = () => showMainMenu();

    // Initialize account picker if wallet already authorised and we have a preferred profile cached
    if (cachedPreferredAddress) {
        try {
            const raw = window.lukso || window.ethereum;
            if (raw) {
                displayAccountPicker({ requestPermission: false }).catch(() => {
                    resetAccountPicker();
                    if (accountPicker) accountPicker.style.display = 'none';
                });
            }
        } catch (_) {
            resetAccountPicker();
            if (accountPicker) accountPicker.style.display = 'none';
        }
    }
    // Keep in sync with wallet account changes
    try {
        const prov = window.lukso || window.ethereum;
        if (prov && typeof prov.on === 'function') {
            prov.on('accountsChanged', async (accs) => {
                const addr = Array.isArray(accs) && accs[0] ? accs[0] : null;
                if (!addr) return;
                let checksum = addr;
                try { checksum = ethers.getAddress(addr); } catch (_) {}
                window.__upAddress = checksum;
                let name = await fetchProfileName(checksum);
                if (!name) name = shortenAddress(checksum);
                window.__upUsername = name;
                try {
                    localStorage.setItem('up.address', checksum);
                    localStorage.setItem('up.username', name);
                    cachedPreferredAddress = checksum;
                    cachedPreferredName = name;
                } catch (_) {}
                if (profileAddressElem) profileAddressElem.textContent = checksum;
                if (profileName) profileName.textContent = name;
                if (profileImage) {
                    try {
                        const img = await fetchAvatarForAddress(checksum);
                        const safeImg = sanitizeImageUrl(img);
                        if (safeImg) {
                            profileImage.src = safeImg;
                            profileImage.style.display = 'inline-block';
                        } else {
                            profileImage.removeAttribute('src');
                            profileImage.style.display = 'none';
                        }
                    } catch (_) {
                        profileImage.removeAttribute('src');
                        profileImage.style.display = 'none';
                    }
                }
                try { await refreshProfilePopup(); } catch (_) {}
            });
            prov.on('chainChanged', async () => {
                try { await refreshProfilePopup(); } catch (_) {}
            });
        }
    } catch (_) {}
    
    // Preveri, če je uporabnik že prijavljen ob zagonu (npr. po refreshu strani)
    // Če je, poskusi auto-reconnect
    try {
        const raw = window.lukso || window.ethereum;
        if (raw && window.__upAddress) {
            // Uporabnik je že prijavljen, poskusi auto-reconnect
            const savedGame = localStorage.getItem('activeGame');
            if (savedGame) {
                console.log('User already logged in, attempting auto-reconnect...');
                // Počakaj malo, da se inicializacija zaključi
                setTimeout(async () => {
                    await tryAutoReconnect(false); // Ne prikaži menija, če ne uspe
                }, 1000);
            }
        }
    } catch (e) {
        console.warn('Failed to check for auto-reconnect on startup:', e);
    }
    
    setMessage('Welcome to Universal Poker.');
};

// Boot
try { 
    initApp(); 
} catch (e) { 
    console.error('init error', e); 
}

// --- ODSTRANJENO ---
// Ogromen podvojen blok kode, ki je bil tukaj, je odstranjen.
// Vseboval je ponovitev logike za `openPanel` in `startJoinRealtime`,
// kar bi povzročilo napake v delovanju aplikacije.