
const express = require("express")
const socket = require("socket.io")
const http = require("http")
const { Chess } = require("chess.js")
const path = require("path")

const app = express()
const server = http.createServer(app)
const io = socket(server)
const chess = new Chess()

let players = {}
let scores = { white: 0, black: 0 }
let drawOfferBy = null
let gameResult = null

const pieceValues = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9
}

const getColor = socketId => {
    if (socketId === players.white) return "w"
    if (socketId === players.black) return "b"
    return null
}

const broadcastGameStatus = () => {
    io.emit("gameStatus", {
        result: gameResult,
        drawOfferBy
    })
}

const finishGame = result => {
    if (gameResult) return

    gameResult = result
    drawOfferBy = null
    broadcastGameStatus()
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

app.set("view engine", "ejs")
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.render("index", { title: "Chess Game" })
})

io.on("connection", uniqueSocket => {
    if (!players.white) {
        players.white = uniqueSocket.id
        uniqueSocket.emit("playerRole", "w")
    } else if (!players.black) {
        players.black = uniqueSocket.id
        uniqueSocket.emit("playerRole", "b")
    } else {
        uniqueSocket.emit("spectatorRole")
    }

    uniqueSocket.emit("boardState", chess.fen())
    uniqueSocket.emit("scoreUpdate", scores)
    uniqueSocket.emit("gameStatus", {
        result: gameResult,
        drawOfferBy
    })

    uniqueSocket.on("move", move => {
        if (gameResult) return

        const color = getColor(uniqueSocket.id)
        if (!color || chess.turn() !== color) return

        try {
            const result = chess.move(move)

            if (!result) {
                uniqueSocket.emit("InvalidMove")
                return
            }

            if (result.captured) {
                const value = pieceValues[result.captured] || 0

                if (result.color === "w") {
                    scores.white += value
                } else {
                    scores.black += value
                }
            }

            drawOfferBy = null

            io.emit("boardState", chess.fen())
            io.emit("scoreUpdate", scores)

            checkGameEnd()
            broadcastGameStatus()
        } catch (error) {
            uniqueSocket.emit("InvalidMove")
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

        if (uniqueSocket.id === players.white) {
            delete players.white
        } else if (uniqueSocket.id === players.black) {
            delete players.black
        }

        if (drawOfferBy === disconnectedColor) {
            drawOfferBy = null
            broadcastGameStatus()
        }
    })
})

server.listen(process.env.PORT || 3000, () => {
    console.log(`listening on port ${process.env.PORT || 3000}`)
})
