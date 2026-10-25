const socket = io()
const chess = new Chess()
const boardElement = document.querySelector(".chessboard")
const roleLabelElement = document.querySelector("#role-label")
const roleDetailElement = document.querySelector("#role-detail")
const whiteClockElement = document.querySelector("#white-clock")
const blackClockElement = document.querySelector("#black-clock")
const whiteClockCard = document.querySelector("#white-clock-card")
const blackClockCard = document.querySelector("#black-clock-card")
const gameStatusElement = document.querySelector("#game-status")
const gameControls = document.querySelector("#game-controls")
const offerDrawButton = document.querySelector("#offer-draw-button")
const resignButton = document.querySelector("#resign-button")
const drawResponse = document.querySelector("#draw-response")
const drawMessage = document.querySelector("#draw-message")
const acceptDrawButton = document.querySelector("#accept-draw-button")
const declineDrawButton = document.querySelector("#decline-draw-button")

let draggedPiece = null
let sourceSquare = null
let playerRole = null
let roleAssigned = false
let selectedSquare = null
let selectedMoves = []
let gameResult = null
let drawOfferBy = null
let noticeText = ""

// Display-only copy of the server clock. The server is the only source of truth;
// this is just used to count the active clock down smoothly between updates.
let clockState = { w: 10 * 60 * 1000, b: 10 * 60 * 1000, running: false, active: null }
let clockReceivedAt = performance.now()

const getSquareName = (row, col) => {
    return `${String.fromCharCode(97 + col)}${8 - row}`
}

const clearSelection = () => {
    selectedSquare = null
    selectedMoves = []
}

const canPlay = () => Boolean(clockState.running) && !gameResult

const formatClock = ms => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

const renderClocks = () => {
    const elapsed = clockState.running ? performance.now() - clockReceivedAt : 0

    const remaining = color => {
        const base = clockState[color]
        return Math.max(0, clockState.active === color ? base - elapsed : base)
    }

    whiteClockElement.textContent = formatClock(remaining("w"))
    blackClockElement.textContent = formatClock(remaining("b"))

    whiteClockCard.classList.toggle(
        "active",
        clockState.running && clockState.active === "w"
    )
    blackClockCard.classList.toggle(
        "active",
        clockState.running && clockState.active === "b"
    )
}

const updateRoleDisplay = () => {
    if (!roleAssigned) {
        roleLabelElement.textContent = "Connecting..."
        roleDetailElement.textContent = "Connecting to the chess game"
    } else if (playerRole === "w") {
        roleLabelElement.textContent = "Player 1"
        roleDetailElement.textContent = "Playing as White"
    } else if (playerRole === "b") {
        roleLabelElement.textContent = "Player 2"
        roleDetailElement.textContent = "Playing as Black"
    } else {
        roleLabelElement.textContent = "Spectator"
        roleDetailElement.textContent = "Watching the game"
    }
}

const getStatusText = () => {
    if (gameResult) {
        if (gameResult.type === "draw") {
            return `Game drawn — ${gameResult.reason}.`
        }

        const winner = gameResult.winner === "w"
            ? "Player 1 (White)"
            : "Player 2 (Black)"

        return `${winner} wins — ${gameResult.reason}.`
    }

    if (drawOfferBy) {
        if (playerRole && playerRole === drawOfferBy) {
            return "Draw offer sent. Waiting for your opponent."
        }

        if (playerRole) {
            return "Your opponent has offered a draw."
        }

        return `${drawOfferBy === "w" ? "White" : "Black"} has offered a draw.`
    }

    if (!clockState.running) {
        return "Waiting for both players to connect. Clocks are paused."
    }

    if (noticeText) return noticeText

    return `${chess.turn() === "w" ? "White" : "Black"} to move`
}

const updateGameStatus = () => {
    gameStatusElement.textContent = getStatusText()
    gameStatusElement.classList.toggle("game-over", Boolean(gameResult))
}

const updateGameControls = () => {
    const isPlayer = playerRole === "w" || playerRole === "b"
    const isOver = Boolean(gameResult)
    const hasOffer = Boolean(drawOfferBy)
    const isOfferer = drawOfferBy === playerRole

    // Only the buttons are player-only. Clocks and status are always visible.
    gameControls.hidden = !isPlayer

    offerDrawButton.disabled = isOver || hasOffer
    resignButton.disabled = isOver

    drawResponse.hidden = isOver || !hasOffer || isOfferer

    if (hasOffer && !isOver) {
        drawMessage.textContent = isOfferer
            ? "Waiting for your opponent to respond."
            : "Your opponent offered a draw. Do you accept?"
    }

    updateGameStatus()
}

const renderBoard = () => {
    const board = chess.board()
    boardElement.innerHTML = ""

    const possibleTargets = new Map(
        selectedMoves.map(move => [move.to, move])
    )

    board.forEach((row, rowindex) => {
        row.forEach((square, squareindex) => {
            const squareName = getSquareName(rowindex, squareindex)
            const squareElement = document.createElement("div")

            squareElement.classList.add(
                "square",
                (rowindex + squareindex) % 2 === 0 ? "light" : "dark"
            )

            squareElement.dataset.row = rowindex
            squareElement.dataset.col = squareindex
            squareElement.dataset.square = squareName

            if (squareName === selectedSquare) {
                squareElement.classList.add("selected")
            }

            const targetMove = possibleTargets.get(squareName)

            if (targetMove) {
                squareElement.classList.add(
                    targetMove.captured || targetMove.flags.includes("e")
                        ? "possible-capture"
                        : "possible-move"
                )
            }

            if (square) {
                const pieceElement = document.createElement("div")

                pieceElement.classList.add(
                    "piece",
                    square.color === "w" ? "white" : "black"
                )

                pieceElement.innerText = getPieceUnicode(square)
                pieceElement.draggable =
                    canPlay() &&
                    playerRole === square.color &&
                    chess.turn() === playerRole

                pieceElement.setAttribute(
                    "aria-label",
                    `${square.color === "w" ? "White" : "Black"} ${square.type}`
                )

                pieceElement.addEventListener("dragstart", event => {
                    if (!pieceElement.draggable) {
                        event.preventDefault()
                        return
                    }

                    draggedPiece = pieceElement
                    sourceSquare = { row: rowindex, col: squareindex }
                    selectedSquare = squareName
                    selectedMoves = chess.moves({
                        square: squareName,
                        verbose: true
                    })

                    event.dataTransfer.setData("text/plain", squareName)
                    event.dataTransfer.effectAllowed = "move"
                })

                pieceElement.addEventListener("dragend", () => {
                    draggedPiece = null
                    sourceSquare = null
                    renderBoard()
                })

                squareElement.append(pieceElement)
            }

            squareElement.addEventListener("click", () => {
                handleSquareClick(rowindex, squareindex)
            })

            squareElement.addEventListener("dragover", event => {
                event.preventDefault()
                if (draggedPiece) event.dataTransfer.dropEffect = "move"
            })

            squareElement.addEventListener("drop", event => {
                event.preventDefault()

                if (!draggedPiece || !sourceSquare || !canPlay()) return

                const targetSquare = {
                    row: Number(squareElement.dataset.row),
                    col: Number(squareElement.dataset.col)
                }

                handleMove(sourceSquare, targetSquare)

                draggedPiece = null
                sourceSquare = null
            })

            boardElement.appendChild(squareElement)
        })
    })

    if (playerRole === "b") {
        boardElement.classList.add("flipped")
    } else {
        boardElement.classList.remove("flipped")
    }
}

const handleSquareClick = (row, col) => {
    if (!canPlay() || !playerRole || chess.turn() !== playerRole) {
        clearSelection()
        renderBoard()
        return
    }

    const targetSquare = getSquareName(row, col)

    const selectedMove = selectedMoves.find(
        move => move.to === targetSquare
    )

    if (selectedSquare && selectedMove) {
        sendMove(
            selectedSquare,
            targetSquare,
            selectedMove.promotion || "q"
        )
        return
    }

    const piece = chess.get(targetSquare)

    if (piece && piece.color === playerRole) {
        if (selectedSquare === targetSquare) {
            clearSelection()
        } else {
            selectedSquare = targetSquare
            selectedMoves = chess.moves({
                square: selectedSquare,
                verbose: true
            })
        }
    } else {
        clearSelection()
    }

    renderBoard()
}

const sendMove = (from, to, promotion = "q") => {
    if (!canPlay()) return

    socket.emit("move", { from, to, promotion })
    clearSelection()
    renderBoard()
}

const handleMove = (source, target) => {
    sendMove(
        getSquareName(source.row, source.col),
        getSquareName(target.row, target.col),
        "q"
    )
}

const getPieceUnicode = piece => {
    const unicodePieces = {
        w: {
            p: "♙",
            r: "♖",
            n: "♘",
            b: "♗",
            q: "♕",
            k: "♔"
        },
        b: {
            p: "♟",
            r: "♜",
            n: "♞",
            b: "♝",
            q: "♛",
            k: "♚"
        }
    }

    return unicodePieces[piece.color][piece.type] || ""
}

socket.on("playerRole", role => {
    playerRole = role
    roleAssigned = true
    updateRoleDisplay()
    updateGameControls()
    clearSelection()
    renderBoard()
})

socket.on("spectatorRole", () => {
    playerRole = null
    roleAssigned = true
    updateRoleDisplay()
    updateGameControls()
    clearSelection()
    renderBoard()
})

socket.on("boardState", fen => {
    const loaded = chess.load(fen)

    if (loaded) {
        noticeText = ""
        clearSelection()
        updateGameStatus()
        renderBoard()
    } else {
        console.error("Received an invalid board position from the server.")
    }
})

socket.on("clockUpdate", state => {
    const runningChanged = clockState.running !== state.running

    clockState = {
        w: state.w,
        b: state.b,
        running: Boolean(state.running),
        active: state.active
    }
    clockReceivedAt = performance.now()

    renderClocks()

    if (runningChanged) {
        // Dragging is only enabled while the clocks run.
        updateGameControls()
        renderBoard()
    } else {
        updateGameStatus()
    }
})

socket.on("gameStatus", status => {
    gameResult = status.result
    drawOfferBy = status.drawOfferBy

    if (gameResult || drawOfferBy) noticeText = ""

    clearSelection()
    updateGameControls()
    renderBoard()
})

socket.on("gameNotice", payload => {
    noticeText = (payload && payload.message) || ""
    updateGameStatus()
})

socket.on("InvalidMove", () => {
    console.warn("The server rejected that move.")
})

offerDrawButton.addEventListener("click", () => {
    if (!gameResult) socket.emit("offerDraw")
})

acceptDrawButton.addEventListener("click", () => {
    if (!gameResult) socket.emit("respondDraw", true)
})

declineDrawButton.addEventListener("click", () => {
    if (!gameResult) socket.emit("respondDraw", false)
})

resignButton.addEventListener("click", () => {
    if (gameResult) return

    const confirmed = window.confirm(
        "Are you sure you want to resign? Your opponent will win."
    )

    if (confirmed) socket.emit("resign")
})

window.addEventListener("beforeunload", event => {
    if (roleAssigned && playerRole && !gameResult) {
        event.preventDefault()
        event.returnValue = ""
    }
})

setInterval(renderClocks, 200)

updateRoleDisplay()
updateGameControls()
renderClocks()
renderBoard()