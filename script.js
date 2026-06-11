/**
 * Songho — script.js
 */

// WS SERVER
const IP = "https://songho-server.onrender.com";
const WS_SERVER_URL = `wssg://songho-server.onrender.com`;
const API_SERVER_URL = `https://songho-server.onrender.com`;

// ─── Navigation entre écrans ──────────────────────────────────────────────

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function goHome() {
    if (activeMode === 'online' && ws) ws.close();
    activeMode = null;
    showScreen('screen-home');
}

function selectMode(mode) {
    if (mode === 'local') showScreen('screen-local-setup');
    else { showScreen('screen-lobby'); loadRooms(); }
}

// ══════════════════════════════════════════════════════════════════════════
//  MODE LOCAL — Moteur embarqué
// ══════════════════════════════════════════════════════════════════════════

let activeMode = null;     // 'local' | 'online'
let localGame  = null;

class LocalEngine {
    constructor(nameSud, nameNord) {
        this.names       = { sud: nameSud, nord: nameNord };
        this.board       = { sud: Array(7).fill(5), nord: Array(7).fill(5) };
        this.scores      = { sud: 0, nord: 0 };
        this.currentSide = 'sud';
        this.gameOver    = false;
        this.winner      = null;
        this.lastMove    = null;
        this.history     = [];
    }

    _snap() {
        return {
            board:       JSON.parse(JSON.stringify(this.board)),
            scores:      { ...this.scores },
            currentSide: this.currentSide
        };
    }

    playMove(side, cellIndex) {
        if (this.gameOver)              return { ok: false, error: 'Partie terminée' };
        if (side !== this.currentSide)  return { ok: false, error: "Ce n'est pas votre tour" };
        if (this.board[side][cellIndex] === 0) return { ok: false, error: 'Case vide' };

        this.history.push(this._snap());

        let seeds = this.board[side][cellIndex];
        this.board[side][cellIndex] = 0;

        let curRow = side, curCol = cellIndex, lastRow, lastCol;

        for (let i = 0; i < seeds; i++) {
            curCol++;
            if (curCol > 6) { curCol = 0; curRow = curRow === 'sud' ? 'nord' : 'sud'; }
            this.board[curRow][curCol]++;
            lastRow = curRow;
            lastCol = curCol;
        }

        let captured = 0, captureMsg = '';
        if (lastRow !== side) {
            const n = this.board[lastRow][lastCol];
            if (n === 2 || n === 3) {
                captured += n;
                this.board[lastRow][lastCol] = 0;
                let ci = lastCol - 1;
                while (ci >= 0 && (this.board[lastRow][ci] === 2 || this.board[lastRow][ci] === 3)) {
                    captured += this.board[lastRow][ci];
                    this.board[lastRow][ci] = 0;
                    ci--;
                }
                this.scores[side] += captured;
                captureMsg = `Capture de ${captured} graine(s)`;
            }
        }

        this.lastMove = {
            side, cell: cellIndex, seeds, captured,
            message: `${this.names[side]} → case ${cellIndex + 1}` +
                     (captured > 0 ? ` — ${captureMsg}` : '')
        };

        const oppSide = side === 'sud' ? 'nord' : 'sud';
        if (!this.board[oppSide].some(c => c > 0)) {
            const rem = this.board[side].reduce((a, b) => a + b, 0);
            this.scores[side] += rem;
            this.board[side] = Array(7).fill(0);
            this.gameOver = true;
            this.winner = side;
            return { ok: true, gameOver: true };
        }

        this.currentSide = oppSide;

        if (!this.board[this.currentSide].some(c => c > 0)) {
            const rem = this.board[this.currentSide].reduce((a, b) => a + b, 0);
            this.scores[side] += rem;
            this.board[this.currentSide] = Array(7).fill(0);
            this.gameOver = true;
            this.winner = side;
            return { ok: true, gameOver: true };
        }

        return { ok: true, gameOver: false };
    }

    undo() {
        if (this.history.length === 0) return false;
        const s = this.history.pop();
        this.board       = s.board;
        this.scores      = s.scores;
        this.currentSide = s.currentSide;
        this.gameOver    = false;
        this.winner      = null;
        return true;
    }

    getState() {
        return {
            board:       this.board,
            scores:      this.scores,
            currentSide: this.currentSide,
            gameOver:    this.gameOver,
            winner:      this.winner,
            lastMove:    this.lastMove,
            canUndo:     this.history.length > 0
        };
    }
}

function startLocalGame() {
    const nameSud  = document.getElementById('localNameSud').value.trim()  || 'Joueur Sud';
    const nameNord = document.getElementById('localNameNord').value.trim() || 'Joueur Nord';
    localGame  = new LocalEngine(nameSud, nameNord);
    activeMode = 'local';
    prepareGameScreen({
        mode:     'local',
        yourSide: null,
        names:    localGame.names
    });
    renderLocalState();
}

function renderLocalState() {
    if (!localGame) return;
    const state = localGame.getState();
    renderState(state, localGame.names, null);
}

// ══════════════════════════════════════════════════════════════════════════
//  MODE RÉSEAU — WebSocket + XMLHttpRequest
// ══════════════════════════════════════════════════════════════════════════

let ws         = null;
let onlineInfo = { playerId: null, yourSide: null, names: {} };

// ── Fonctions AJAX avec XMLHttpRequest ─────────────────────────────────────

/**
 * Effectue une requête AJAX GET avec XMLHttpRequest
 */
function ajaxGet(url, onSuccess, onError) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    
    xhr.onreadystatechange = function() {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (onSuccess) onSuccess(data);
                } catch (e) {
                    if (onError) onError('Erreur de parsing JSON: ' + e.message);
                }
            } else {
                if (onError) onError(`Erreur HTTP ${xhr.status}: ${xhr.statusText}`);
            }
        }
    };
    
    xhr.onerror = function() {
        if (onError) onError('Erreur de connexion réseau');
    };
    
    xhr.send();
}

/**
 * Effectue une requête AJAX POST avec XMLHttpRequest
 */
function ajaxPost(url, data, onSuccess, onError) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    
    xhr.onreadystatechange = function() {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    const responseData = JSON.parse(xhr.responseText);
                    if (onSuccess) onSuccess(responseData);
                } catch (e) {
                    if (onError) onError('Erreur de parsing JSON: ' + e.message);
                }
            } else {
                if (onError) onError(`Erreur HTTP ${xhr.status}: ${xhr.statusText}`);
            }
        }
    };
    
    xhr.onerror = function() {
        if (onError) onError('Erreur de connexion réseau');
    };
    
    xhr.send(JSON.stringify(data));
}

// ── Lobby avec XMLHttpRequest ─────────────────────────────────────────────

function loadRooms() {
    const list = document.getElementById('rooms-list');
    list.innerHTML = '<p class="rooms-empty">Chargement…</p>';
    
    const apiUrl = `${API_SERVER_URL}/api/rooms`;
    console.log('Chargement des salles depuis:', apiUrl);
    
    ajaxGet(apiUrl, 
        // Succès
        function(rooms) {
            renderRooms(rooms);
        },
        // Erreur
        function(error) {
            console.error('Erreur loadRooms:', error);
            list.innerHTML = '<p class="rooms-empty">Impossible de contacter le serveur. Vérifiez que le serveur est lancé sur http://' + IP + ':3000</p>';
        }
    );
}

function renderRooms(rooms) {
    const list = document.getElementById('rooms-list');
    if (rooms.length === 0) {
        list.innerHTML = '<p class="rooms-empty">Aucune partie disponible. Créez-en une !</p>';
        return;
    }
    list.innerHTML = rooms.map(r => `
        <div class="room-item">
            <div class="room-info">
                <div class="room-name">${escHtml(r.name)}</div>
                <div class="room-meta">
                    ${r.playerCount}/2 joueurs
                    ${r.players.sud ? `· Sud: ${escHtml(r.players.sud)}` : ''}
                    ${r.players.nord ? `· Nord: ${escHtml(r.players.nord)}` : ''}
                </div>
            </div>
            ${r.full
                ? '<span class="room-full-badge">PLEIN</span>'
                : `<button class="btn btn-primary btn-sm" onclick="joinRoom('${r.id}')">Rejoindre</button>`
            }
        </div>
    `).join('');
}

function showCreateRoom()  { document.getElementById('create-room-box').style.display = 'flex'; }
function hideCreateRoom()  { document.getElementById('create-room-box').style.display = 'none'; }

function createRoom() {
    const name = document.getElementById('roomNameInput').value.trim() || 'Partie';
    const apiUrl = `${API_SERVER_URL}/api/rooms`;
    console.log('Création salle sur:', apiUrl);
    
    ajaxPost(apiUrl, { name: name },
        // Succès
        function(data) {
            console.log("Salle créée:", data);
            hideCreateRoom();
            joinRoom(data.roomId);
        },
        // Erreur
        function(error) {
            console.error("Erreur création salle:", error);
            alert('Impossible de créer la partie. Vérifiez que le serveur est lancé.\n\n' + error);
        }
    );
}

function joinRoom(roomId) {
    const playerName = document.getElementById('onlineName').value.trim();
    if (!playerName) { alert('Entrez votre pseudo avant de rejoindre.'); return; }
    connectWS(roomId, playerName);
}

// ── WebSocket (conserver pour les mises à jour temps réel) ─────────────────

function connectWS(roomId, playerName) {
    let wsUrl = WS_SERVER_URL;
    
    console.log('Connexion WebSocket à:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connecté');
        ws.send(JSON.stringify({ type: 'join', roomId, name: playerName }));
    };

    ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        handleServerMsg(msg);
    };

    ws.onclose = () => {
        console.log('WebSocket fermé');
        if (activeMode === 'online') showDisconnected('Connexion au serveur perdue.');
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showDisconnected('Erreur de connexion au serveur.');
    };
}

function handleServerMsg(msg) {
    switch (msg.type) {
        case 'joined':
            onlineInfo.playerId = msg.playerId;
            onlineInfo.yourSide = msg.yourSide;
            onlineInfo.names    = msg.names;
            activeMode = 'online';
            prepareGameScreen({
                mode:     'online',
                yourSide: msg.yourSide,
                names:    msg.names,
                roomName: msg.roomName
            });
            setStatus('En attente d\'un adversaire…');
            addHistory('Connecté — côté ' + (msg.yourSide === 'sud' ? 'Sud' : 'Nord'));
            break;

        case 'waiting':
            setStatus('En attente d\'un adversaire…');
            break;

        case 'gameStart':
            onlineInfo.names = msg.names || onlineInfo.names;
            renderState(msg.state, onlineInfo.names, onlineInfo.yourSide);
            addHistory('La partie commence !');
            document.getElementById('rematchBtn').style.display = 'none';
            break;

        case 'gameUpdate':
            onlineInfo.names = msg.names || onlineInfo.names;
            renderState(msg.state, onlineInfo.names, onlineInfo.yourSide);
            if (msg.state.lastMove?.message) addHistory(msg.state.lastMove.message);
            if (msg.type === 'gameEnd' || msg.state.gameOver) {
                document.getElementById('rematchBtn').style.display = 'inline-flex';
            }
            break;

        case 'gameEnd':
            addHistory(`Victoire de ${msg.winnerName} !`);
            document.getElementById('rematchBtn').style.display = 'inline-flex';
            break;

        case 'undo':
            onlineInfo.names = msg.names || onlineInfo.names;
            renderState(msg.state, onlineInfo.names, onlineInfo.yourSide);
            addHistory('Coup annulé');
            break;

        case 'opponentLeft':
            showDisconnected(msg.message || 'Votre adversaire a quitté la partie.');
            break;

        case 'error':
            addHistory('' + msg.message);
            break;
    }
}

// ── Actions réseau ────────────────────────────────────────────────────────

function sendWS(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onlinePLayMove(cellIndex) {
    sendWS({ type: 'move', cell: cellIndex });
}

// ══════════════════════════════════════════════════════════════════════════
//  RENDU COMMUN (identique)
// ══════════════════════════════════════════════════════════════════════════

let _yourSide = null;
let _names    = {};

function prepareGameScreen({ mode, yourSide, names, roomName }) {
    _yourSide = yourSide;
    _names    = names;

    document.getElementById('gameModeLabel').textContent = mode === 'local' ? 'LOCAL' : 'EN RESEAU';
    document.getElementById('roomLabel').textContent     = roomName ? `${roomName}` : '';

    showScreen('screen-game');
    document.getElementById('rematchBtn').style.display = 'none';
    document.getElementById('historyList').innerHTML = '';
    addHistory('Bienvenue dans Songho !');
}

function renderState(state, names, yourSide) {
    if (!state) return;
    _names    = names;
    _yourSide = yourSide;

    document.getElementById('sudName').textContent   = names.sud  || 'Sud';
    document.getElementById('nordName').textContent  = names.nord || 'Nord';
    document.getElementById('scoreSud').textContent  = state.scores.sud;
    document.getElementById('scoreNord').textContent = state.scores.nord;

    const turnName = names[state.currentSide] || state.currentSide;
    document.getElementById('turnBox').textContent = state.gameOver
        ? `${names[state.winner] || state.winner}`
        : `Tour : ${turnName}`;

    if (state.gameOver) {
        const winName = names[state.winner] || state.winner;
        setStatus(`Victoire de ${winName} !`);
        setSideStatus('sud',  state.winner === 'sud'  ? 'Vainqueur' : '');
        setSideStatus('nord', state.winner === 'nord' ? 'Vainqueur' : '');
    } else {
        if (activeMode === 'online' && yourSide) {
            setStatus(state.currentSide === yourSide ? 'C\'est votre tour !' : 'Tour de l\'adversaire…');
            setSideStatus(yourSide, state.currentSide === yourSide ? 'Jouez !' : '');
        } else {
            setStatus(`Tour : ${turnName}`);
        }
    }

    renderBoard(state.board, state, yourSide);

    if (state.lastMove?.message) {
        document.getElementById('lastMoveText').textContent = state.lastMove.message;
    }

    document.getElementById('undoBtn').disabled = !state.canUndo;

    if (state.gameOver) {
        document.getElementById('rematchBtn').style.display = 'inline-flex';
    }
}

function renderBoard(board, state, yourSide) {
    const nordEl = document.getElementById('row-nord');
    nordEl.innerHTML = '';
    for (let i = 6; i >= 0; i--) {
        nordEl.appendChild(createCell(board.nord[i], i, 'nord', state, yourSide));
    }

    const sudEl = document.getElementById('row-sud');
    sudEl.innerHTML = '';
    for (let i = 0; i <= 6; i++) {
        sudEl.appendChild(createCell(board.sud[i], i, 'sud', state, yourSide));
    }
}

function createCell(seeds, index, side, state, yourSide) {
    const cell = document.createElement('div');
    cell.className = 'cell';

    let canPlay = false;
    if (!state.gameOver && seeds > 0) {
        if (activeMode === 'local') {
            canPlay = (side === state.currentSide);
        } else {
            canPlay = (side === yourSide && side === state.currentSide);
        }
    }

    if (canPlay) {
        cell.classList.add('playable');
        cell.addEventListener('click', () => doPlayMove(side, index));
    }

    cell.innerHTML = `
        <div class="cell-count">${seeds}</div>
        <div class="cell-label">${index + 1}</div>
    `;

    return cell;
}

function doPlayMove(side, cellIndex) {
    if (activeMode === 'local') {
        if (!localGame) return;
        const result = localGame.playMove(side, cellIndex);
        if (!result.ok) { addHistory('' + result.error); return; }
        const state = localGame.getState();
        renderState(state, localGame.names, null);
        if (state.lastMove?.message) addHistory(state.lastMove.message);
        if (result.gameOver) {
            addHistory(`Victoire de ${localGame.names[state.winner]} !`);
        }
    } else {
        onlinePLayMove(cellIndex);
    }
}

function doUndo() {
    if (activeMode === 'local') {
        if (localGame && localGame.undo()) {
            renderState(localGame.getState(), localGame.names, null);
            addHistory('↩ Coup annulé');
        }
    } else {
        sendWS({ type: 'undo' });
    }
}

function doRematch() {
    if (activeMode === 'local') {
        localGame = new LocalEngine(localGame.names.sud, localGame.names.nord);
        renderState(localGame.getState(), localGame.names, null);
        document.getElementById('rematchBtn').style.display = 'none';
        addHistory('Nouvelle partie !');
    } else {
        sendWS({ type: 'rematch' });
    }
}

function leaveGame() {
    if (activeMode === 'online') {
        sendWS({ type: 'leave' });
        if (ws) ws.close();
        ws = null;
    }
    localGame  = null;
    activeMode = null;
    goHome();
}

// ── Modals ────────────────────────────────────────────────────────────────

function showRulesModal()  { document.getElementById('modal-rules').style.display = 'flex'; }
function hideRulesModal()  { document.getElementById('modal-rules').style.display = 'none'; }

function showDisconnected(msg) {
    document.getElementById('disconnectMsg').textContent = msg;
    document.getElementById('modal-disconnected').style.display = 'flex';
}

// ── Helpers ───────────────────────────────────────────────────────────────

function setStatus(txt) {
    document.getElementById('statusBar').textContent = txt;
}

function setSideStatus(side, txt) {
    document.getElementById(side === 'sud' ? 'sudStatus' : 'nordStatus').textContent = txt;
}

function addHistory(msg) {
    const ul = document.getElementById('historyList');
    if (!ul) return;
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} – ${msg}`;
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 50) ul.removeChild(ul.lastChild);
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}