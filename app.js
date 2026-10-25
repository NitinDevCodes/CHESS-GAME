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

const pieceValues = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9
}

app.set("view engine", "ejs")
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.render("index", { title: "Chess Game" })
})

io.on("connection", (uniqueSocket) => {
    console.log("connected")

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

    uniqueSocket.on("disconnect", () => {
        if (uniqueSocket.id === players.white) {
            delete players.white
        } else if (uniqueSocket.id === players.black) {
            delete players.black
        }
    })

    uniqueSocket.on("move", (move) => {
        try {
            if (
                chess.turn() === "w" &&
                uniqueSocket.id !== players.white
            ) return

            if (
                chess.turn() === "b" &&
                uniqueSocket.id !== players.black
            ) return

            const result = chess.move(move)

            if (result) {
                if (result.captured) {
                    const capturedValue =
                        pieceValues[result.captured] || 0

                    if (result.color === "w") {
                        scores.white += capturedValue
                    } else {
                        scores.black += capturedValue
                    }
                }

                io.emit("boardState", chess.fen())
                io.emit("scoreUpdate", scores)
            } else {
                uniqueSocket.emit("InvalidMove", move)
            }
        } catch (error) {
            uniqueSocket.emit("InvalidMove", move)
        }
    })
})

server.listen(3000, () => {
    console.log("listening")
})