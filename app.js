const express = require("express")
const socket = require("socket.io")
const http = require("http")
const { Chess } = require("chess.js")
const path = require("path")
const { performance } = require("perf_hooks")

const app = express()
const server = http.createServer(app)
const io = socket(server)
const chess = new Chess()

const INITIAL_TIME_MS = Number(process.env.CHESS_CLOCK_MS) || 10 * 60 * 1000
const CLOCK_BROADCAST_INTERVAL_MS = 1000

const RESET_DELAY_MS = Number(process.env.CHESS_RESET_DELAY_MS) || 10 * 1000

const SEAT_KEYS = { w: "white", b: "black" }

let players = {}
let drawOfferBy = null
let gameResult = null

const seatSockets = { w: null, b: null }
const seatOwners = { w: null, b: null }
const pendingResets = { w: null, b: null }

let gameGeneration = 0

const clock = {
    w: INITIAL_TIME_MS,
    b: INITIAL_TIME_MS,
    running: false,
    active: null,
    lastTick: null
}

let timeoutTimer = null
let broadcastTimer = null

const opposite = color => (color === "w" ? "b" : "w")
const colorName = color => (color === "w" ? "White" : "Black")

const getColor = socketId => {
    if (socketId === players.white) return "w"
    if (socketId === players.black) return "b"
    return null
}

const bothPlayersSeated = () => Boolean(players.white && players.black)

// The persistent id the browser keeps in sessionStorage and sends when connecting.
const getPlayerId = uniqueSocket => {
    const query = uniqueSocket.handshake && uniqueSocket.handshake.query
    const raw = query && query.playerId

    return typeof raw === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw)
        ? raw
        : null
}

/*
 * Can `color` possibly checkmate the opponent in some sequence of legal moves?
 * Used for the timeout rule: if the player who did NOT run out of time can never
 * deliver mate, the game is drawn instead of won.
 */
const canDeliverMate = (game, color) => {
    const own = []
    let opponentHasPieces = false

    game.board().forEach((row, rowIndex) => {
        row.forEach((square, colIndex) => {
            if (!square || square.type === "k") return

            if (square.color === color) {
                own.push({
                    type: square.type,
                    squareColor: (rowIndex + colIndex) % 2
                })
            } else {
                opponentHasPieces = true
            }
        })
    })

    // A pawn can promote; a rook or queen can mate.
    if (own.some(piece => "pqr".includes(piece.type))) return true

    // Bare king.
    if (own.length === 0) return false

    // One minor piece can only mate if the opponent has a piece that can
    // block its own king (a helpmate).
    if (own.length === 1) return opponentHasPieces

    // Only bishops, all on the same square colour: same situation as one minor piece.
    const onlyBishops = own.every(piece => piece.type === "b")
    const sameColourBishops =
        onlyBishops && own.every(piece => piece.squareColor === own[0].squareColor)

    if (sameColourBishops) return opponentHasPieces

    // Two or more knights, or bishops on opposite colours, etc.: mate is possible.
    return true
}

// Describes the earliest pending reset so every client can show a countdown.
const getPendingResetInfo = () => {
    const records = ["w", "b"].map(color => pendingResets[color]).filter(Boolean)

    if (records.length === 0) return null

    const now = performance.now()

    return {
        colors: records.map(record => record.color),
        inMs: Math.max(
            0,
            Math.round(Math.min(...records.map(record => record.deadline - now)))
        )
    }
}

const getGameStatus = () => ({
    result: gameResult,
    drawOfferBy,
    pendingReset: getPendingResetInfo()
})

const broadcastGameStatus = () => {
    io.emit("gameStatus", getGameStatus())
}

// Brings the active player's remaining time up to date.
const syncClock = () => {
    if (!clock.running) return

    const now = performance.now()
    const elapsed = Math.max(0, now - clock.lastTick)

    clock[clock.active] = Math.max(0, clock[clock.active] - elapsed)
    clock.lastTick = now
}

const getClockSnapshot = () => {
    syncClock()

    return {
        w: Math.round(clock.w),
        b: Math.round(clock.b),
        running: clock.running,
        active: clock.running ? clock.active : null
    }
}

const broadcastClock = () => {
    io.emit("clockUpdate", getClockSnapshot())
}

const clearClockTimers = () => {
    clearTimeout(timeoutTimer)
    clearInterval(broadcastTimer)
    timeoutTimer = null
    broadcastTimer = null
}

const stopClock = () => {
    syncClock()

    clock.running = false
    clock.active = null
    clock.lastTick = null
    clearClockTimers()
}

const finishGame = result => {
    if (gameResult) return

    stopClock()
    gameResult = result
    drawOfferBy = null

    broadcastClock()
    broadcastGameStatus()
}

const endOnTime = loser => {
    if (gameResult) return

    const winner = opposite(loser)
    clock[loser] = 0

    if (canDeliverMate(chess, winner)) {
        finishGame({
            type: "win",
            winner,
            reason: `${colorName(loser)} ran out of time`
        })
    } else {
        finishGame({
            type: "draw",
            reason: `${colorName(loser)} ran out of time, but ${colorName(winner)} has insufficient material to checkmate`
        })
    }
}

const scheduleTimeout = () => {
    clearTimeout(timeoutTimer)
    timeoutTimer = null

    if (!clock.running || gameResult) return

    const generation = gameGeneration

    timeoutTimer = setTimeout(
        () => handleTimerFired(generation),
        Math.max(1, Math.ceil(clock[clock.active]))
    )
}

const handleTimerFired = generation => {
    // A timer from before a reset must never touch the new game.
    if (generation !== gameGeneration) return

    timeoutTimer = null

    if (gameResult || !clock.running) return

    syncClock()

    // Timers can fire slightly early; check the real remaining time.
    if (clock[clock.active] > 0) {
        scheduleTimeout()
        return
    }

    endOnTime(clock.active)
}

// Starts (or resumes) the clock only when both player slots are filled.
const startClock = () => {
    if (clock.running || gameResult || !bothPlayersSeated()) return

    clock.running = true
    clock.active = chess.turn()
    clock.lastTick = performance.now()

    scheduleTimeout()
    broadcastTimer = setInterval(broadcastClock, CLOCK_BROADCAST_INTERVAL_MS)
    broadcastClock()
}

const checkGameEnd = () => {
    if (chess.isCheckmate()) {
        finishGame({
            type: "win",
            winner: chess.turn() === "w" ? "b" : "w",
            reason: "Checkmate"
        })
    } else if (chess.isStalemate()) {
        finishGame({
            type: "draw",
            reason: "Stalemate"
        })
    } else if (chess.isThreefoldRepetition()) {
        finishGame({
            type: "draw",
            reason: "Draw by threefold repetition"
        })
    } else if (chess.isInsufficientMaterial()) {
        finishGame({
            type: "draw",
            reason: "Draw by insufficient material"
        })
    } else if (chess.isDraw()) {
        finishGame({
            type: "draw",
            reason: "Draw by chess rules"
        })
    }
}

const sanitizeMove = move => {
    if (!move || typeof move !== "object") return null

    const { from, to, promotion } = move
    const squarePattern = /^[a-h][1-8]$/

    if (typeof from !== "string" || typeof to !== "string") return null
    if (!squarePattern.test(from) || !squarePattern.test(to)) return null

    const cleanMove = { from, to }

    if (promotion !== undefined && promotion !== null) {
        if (typeof promotion !== "string" || !/^[qrbn]$/.test(promotion)) {
            return null
        }

        cleanMove.promotion = promotion
    }

    return cleanMove
}


const cancelPendingReset = color => {
    const record = pendingResets[color]

    if (!record) return false

    clearTimeout(record.timer)
    pendingResets[color] = null

    return true
}

const cancelAllPendingResets = () => {
    cancelPendingReset("w")
    cancelPendingReset("b")
}

const resetGame = () => {
    gameGeneration += 1
    cancelAllPendingResets()
    stopClock()

    chess.reset()

    clock.w = INITIAL_TIME_MS
    clock.b = INITIAL_TIME_MS
    gameResult = null
    drawOfferBy = null

    ;["w", "b"].forEach(color => {
        if (!seatSockets[color]) {
            seatOwners[color] = null
            delete players[SEAT_KEYS[color]]
        }
    })

    io.emit("boardState", chess.fen())
    io.emit("clockUpdate", getClockSnapshot())
    broadcastGameStatus()
    io.emit("gameNotice", {
        message: "The game was reset because a player did not reconnect in time."
    })

    startClock()
}

const startPendingReset = color => {
    cancelPendingReset(color)

    const record = {
        color,
        generation: gameGeneration,
        deadline: performance.now() + RESET_DELAY_MS,
        timer: null
    }

    record.timer = setTimeout(() => {
        if (pendingResets[color] !== record) return
        if (record.generation !== gameGeneration) return

        resetGame()
    }, RESET_DELAY_MS)

    pendingResets[color] = record
}

const claimSeat = (uniqueSocket, playerId) => {
    if (playerId) {
        for (const color of ["w", "b"]) {
            if (seatOwners[color] !== playerId) continue

            const previousSocket = seatSockets[color]
            const cancelled = cancelPendingReset(color)

            players[SEAT_KEYS[color]] = uniqueSocket.id
            seatSockets[color] = uniqueSocket

            if (previousSocket && previousSocket.id !== uniqueSocket.id) {
                previousSocket.disconnect(true)
            }

            return { color, reclaimed: cancelled || Boolean(previousSocket) }
        }
    }

    for (const color of ["w", "b"]) {
        if (!players[SEAT_KEYS[color]] && !pendingResets[color]) {
            players[SEAT_KEYS[color]] = uniqueSocket.id
            seatSockets[color] = uniqueSocket
            seatOwners[color] = playerId

            return { color, reclaimed: false }
        }
    }

    return { color: null, reclaimed: false }
}

app.set("view engine", "ejs")
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.render("index", { title: "Chess Game" })
})

io.on("connection", uniqueSocket => {
    const { color: seatColor, reclaimed } = claimSeat(
        uniqueSocket,
        getPlayerId(uniqueSocket)
    )

    if (seatColor) {
        uniqueSocket.emit("playerRole", seatColor)
    } else {
        uniqueSocket.emit("spectatorRole")
    }

    uniqueSocket.emit("boardState", chess.fen())
    uniqueSocket.emit("clockUpdate", getClockSnapshot())

    if (reclaimed) {
        broadcastGameStatus()
    } else {
        uniqueSocket.emit("gameStatus", getGameStatus())
    }

    startClock()

    uniqueSocket.on("move", move => {
        if (gameResult || !clock.running) return

        const color = getColor(uniqueSocket.id)
        if (!color || chess.turn() !== color || clock.active !== color) return

        syncClock()

        if (clock[color] <= 0) {
            endOnTime(color)
            return
        }

        const cleanMove = sanitizeMove(move)

        if (!cleanMove) {
            uniqueSocket.emit("InvalidMove")
            return
        }

        try {
            const result = chess.move(cleanMove)

            if (!result) {
                uniqueSocket.emit("InvalidMove")
                return
            }
        } catch (error) {
            uniqueSocket.emit("InvalidMove")
            return
        }

        syncClock()
        clock.active = chess.turn()
        clock.lastTick = performance.now()
        scheduleTimeout()

        drawOfferBy = null

        io.emit("boardState", chess.fen())

        checkGameEnd()

        if (!gameResult) {
            broadcastClock()
            broadcastGameStatus()
        }
    })

    uniqueSocket.on("offerDraw", () => {
        const color = getColor(uniqueSocket.id)

        if (!color || gameResult || drawOfferBy) return

        drawOfferBy = color
        broadcastGameStatus()
    })

    uniqueSocket.on("respondDraw", accept => {
        const color = getColor(uniqueSocket.id)

        if (!color || gameResult || !drawOfferBy) return
        if (color === drawOfferBy) return

        if (accept === true) {
            finishGame({
                type: "draw",
                reason: "Draw by agreement"
            })
        } else if (accept === false) {
            drawOfferBy = null

            io.emit("gameNotice", {
                message: `${colorName(color)} declined the draw offer.`
            })
            broadcastGameStatus()
        }
    })

    uniqueSocket.on("resign", () => {
        const color = getColor(uniqueSocket.id)

        if (!color || gameResult) return

        finishGame({
            type: "win",
            winner: color === "w" ? "b" : "w",
            reason: color === "w"
                ? "White resigned"
                : "Black resigned"
        })
    })

    uniqueSocket.on("disconnect", () => {
        const disconnectedColor = getColor(uniqueSocket.id)

        if (!disconnectedColor) return

        delete players[SEAT_KEYS[disconnectedColor]]
        seatSockets[disconnectedColor] = null

        if (clock.running) {
            syncClock()

            if (clock[clock.active] <= 0) {
                endOnTime(clock.active)
            } else {
                // Otherwise pause both clocks while a player slot is empty.
                stopClock()
                broadcastClock()
            }
        }

        if (drawOfferBy === disconnectedColor) {
            drawOfferBy = null
        }

        startPendingReset(disconnectedColor)
        broadcastGameStatus()
    })
})

server.listen(process.env.PORT || 3000, () => {
    console.log(`listening on port ${process.env.PORT || 3000}`)
})