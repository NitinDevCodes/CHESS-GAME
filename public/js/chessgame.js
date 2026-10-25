const socket = io();
const chess = new Chess();
const boardElement = document.querySelector(".chessboard");

let draggedPiece = null;
let sourceSquare = null;
let playerRole = null;

let selectedSquare = null;
let selectedMoves = [];

const getSquareName = (row, col) => {
    return `${String.fromCharCode(97 + col)}${8 - row}`;
};

const clearSelection = () => {
    selectedSquare = null;
    selectedMoves = [];
};

const renderBoard = () => {
    const board = chess.board();
    boardElement.innerHTML = "";

    const possibleTargets = new Map(
        selectedMoves.map(move => [move.to, move])
    );

    board.forEach((row, rowindex) => {
        row.forEach((square, squareindex) => {
            const squareName = getSquareName(
                rowindex,
                squareindex
            );

            const squareElement = document.createElement("div");

            squareElement.classList.add(
                "square",
                (rowindex + squareindex) % 2 === 0
                    ? "light"
                    : "dark"
            );

            squareElement.dataset.row = rowindex;
            squareElement.dataset.col = squareindex;
            squareElement.dataset.square = squareName;

            if (squareName === selectedSquare) {
                squareElement.classList.add("selected");
            }

            const targetMove = possibleTargets.get(squareName);

            if (targetMove) {
                const isCapture =
                    Boolean(targetMove.captured) ||
                    targetMove.flags.includes("e");

                squareElement.classList.add(
                    isCapture
                        ? "possible-capture"
                        : "possible-move"
                );
            }

            // Render a piece if the square is occupied.
            if (square) {
                const pieceElement = document.createElement("div");

                pieceElement.classList.add(
                    "piece",
                    square.color === "w" ? "white" : "black"
                );

                pieceElement.innerText = getPieceUnicode(square);

                pieceElement.draggable =
                    playerRole === square.color &&
                    chess.turn() === playerRole;

                pieceElement.setAttribute(
                    "aria-label",
                    `${square.color === "w" ? "White" : "Black"} ${square.type}`
                );

                pieceElement.addEventListener("dragstart", (event) => {
                    if (!pieceElement.draggable) {
                        event.preventDefault();
                        return;
                    }

                    draggedPiece = pieceElement;

                    sourceSquare = {
                        row: rowindex,
                        col: squareindex
                    };

                    event.dataTransfer.setData(
                        "text/plain",
                        squareName
                    );

                    event.dataTransfer.effectAllowed = "move";
                });

                pieceElement.addEventListener("dragend", () => {
                    draggedPiece = null;
                    sourceSquare = null;
                });

                squareElement.appendChild(pieceElement);
            }

            squareElement.addEventListener("click", () => {
                handleSquareClick(rowindex, squareindex);
            });

            squareElement.addEventListener("dragover", (event) => {
                event.preventDefault();

                if (draggedPiece) {
                    event.dataTransfer.dropEffect = "move";
                }
            });

            squareElement.addEventListener("drop", (event) => {
                event.preventDefault();

                if (!draggedPiece || !sourceSquare) {
                    return;
                }

                const targetSquare = {
                    row: Number(squareElement.dataset.row),
                    col: Number(squareElement.dataset.col)
                };

                handleMove(sourceSquare, targetSquare);

                draggedPiece = null;
                sourceSquare = null;
            });

            boardElement.appendChild(squareElement);
        });
    });

    if (playerRole === "b") {
        boardElement.classList.add("flipped");
    } else {
        boardElement.classList.remove("flipped");
    }
};

const handleSquareClick = (row, col) => {
    if (!playerRole || chess.turn() !== playerRole) {
        clearSelection();
        renderBoard();
        return;
    }

    const targetSquare = getSquareName(row, col);

    const selectedMove = selectedMoves.find(
        move => move.to === targetSquare
    );

    if (selectedSquare && selectedMove) {
        sendMove(
            selectedSquare,
            targetSquare,
            selectedMove.promotion || "q"
        );

        return;
    }

    const piece = chess.get(targetSquare);

    if (piece && piece.color === playerRole) {
        if (selectedSquare === targetSquare) {
            clearSelection();
        } else {
            selectedSquare = targetSquare;

            selectedMoves = chess.moves({
                square: selectedSquare,
                verbose: true
            });
        }
    } else {
        clearSelection();
    }

    renderBoard();
};

const sendMove = (from, to, promotion = "q") => {
    socket.emit("move", {
        from,
        to,
        promotion
    });

    clearSelection();
    renderBoard();
};

const handleMove = (source, target) => {
    const from = getSquareName(
        source.row,
        source.col
    );

    const to = getSquareName(
        target.row,
        target.col
    );

    sendMove(from, to, "q");
};

const getPieceUnicode = (piece) => {
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
    };

    return unicodePieces[piece.color][piece.type] || "";
};

socket.on("playerRole", (role) => {
    playerRole = role;

    clearSelection();
    renderBoard();
});

socket.on("spectatorRole", () => {
    playerRole = null;

    clearSelection();
    renderBoard();
});

socket.on("boardState", (fen) => {
    const loaded = chess.load(fen);

    if (loaded) {
        clearSelection();
        renderBoard();
    } else {
        console.error(
            "Received an invalid board position from the server."
        );
    }
});

socket.on("InvalidMove", () => {
    console.warn("The server rejected that move.");
});

renderBoard();