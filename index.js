/** @format */
// just some comment to change file

const bodyParser = require("body-parser");
const express = require("express");
const cors = require("cors");
const request = require("request");
const path = require("path");
const Blockchain = require("./Blockchain/blockchain");
const PubSub = require("./app/pubsub");
const TransactionPool = require("./wallet/transaction-pool");
const Wallet = require("./wallet/wallet");
const TransactionMiner = require("./app/transaction-miner");

const isDevelopment = process.env.ENV === "development";
const REDIS_URL = isDevelopment
  ? "redis://127.0.0.1:6379"
  : "redis://:pe6d35e3912c778f9f1a8488601e2168b59240e282647789a0aba6a599cf925c7@ec2-3-222-21-116.compute-1.amazonaws.com:19979";
const DEFAULT_PORT = 3000;
const ROOT_NODE_ADDRESS = isDevelopment
  ? `http://localhost:${DEFAULT_PORT}`
  : `https://tranquil-everglades-92979.herokuapp.com`;

const app = express();
const blockchain = new Blockchain();
const transactionPool = new TransactionPool();
const wallet = new Wallet();
const pubsub = new PubSub({ blockchain, transactionPool, redisUrl: REDIS_URL });
const transactionMiner = new TransactionMiner({
  blockchain,
  transactionPool,
  wallet,
  pubsub,
});

app.use(bodyParser.json());
app.use(cors());
//app.use(express.static(path.join(__dirname, "client/dist")));

app.get("/api/blocks", (req, res) => {
  res.json(blockchain.chain);
});

app.get("/api/blocks/length", (req, res) => {
  res.json(blockchain.chain.length);
});

app.get("/api/blocks/:id", (req, res) => {
  const { id } = req.params;
  const { length } = blockchain.chain;

  let blocksReversed = blockchain.chain.slice().reverse();

  let startIndex = (id - 1) * 5;
  let endIndex = id * 5;

  startIndex = startIndex < length ? startIndex : length;
  endIndex = endIndex < length ? endIndex : length;

  res.json(blocksReversed.slice(startIndex, endIndex));
});

app.post("/api/mine", (req, res) => {
  const { data } = req.body;

  blockchain.addBlock({ data });
  pubsub.broadcastChain();

  res.redirect("/api/blocks");
});

app.post("/api/transact", (req, res) => {
  const { amount, recipient } = req.body;
  let transaction = transactionPool.existingTransaction({
    inputAddress: wallet.publicKey,
  });

  try {
    if (transaction) {
      transaction.updateTransaction({
        senderWallet: wallet,
        recipient,
        amount,
      });
    } else {
      transaction = wallet.createTransaction({
        recipient,
        amount,
        chain: blockchain.chain,
      });
    }
  } catch (error) {
    return res.status(400).json({ type: "error", message: error.message });
  }

  transactionPool.setTransaction(transaction);

  pubsub.broadcastTransaction(transaction);

  res.json({ type: "success", transaction });
});

app.get("/api/transaction-pool-map", (req, res) => {
  res.json(transactionPool.transactionMap);
});

app.get("/api/mine-transactions", (req, res) => {
  transactionMiner.mineTransaction();

  res.redirect("/api/blocks");
});

app.get("/api/wallet-info", (req, res) => {
  const address = wallet.publicKey;
  res.json({
    address,
    balance: Wallet.calculateBalance({
      chain: blockchain.chain,
      address,
    }),
  });
});

app.get("/api/known-addresses", (req, res) => {
  const addressMap = {};

  for (let block of blockchain.chain) {
    for (let transaction of block.data) {
      const recipient = Object.keys(transaction.outputMap);

      recipient.forEach((recipient) => (addressMap[recipient] = recipient));
    }
  }

  res.json(Object.keys(addressMap));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "client/dist/index.html"));
});

const syncWithRootState = () => {
  request(
    { url: `${ROOT_NODE_ADDRESS}/api/blocks` },
    (error, response, body) => {
      if (!error && response.statusCode === 200) {
        const rootChain = JSON.parse(body);

        console.log("replace chain on a sync with", rootChain);
        blockchain.replaceChain(rootChain);
      }
    }
  );

  request(
    { url: `${ROOT_NODE_ADDRESS}/api/transaction-pool-map` },
    (error, response, body) => {
      if (!error && response.statusCode === 200) {
        const rootTransactionPoolMap = JSON.parse(body);

        console.log(
          "replace transaction pool map on a sync with",
          rootTransactionPoolMap
        );
        transactionPool.setMap(rootTransactionPoolMap);
      }
    }
  );
};

if (isDevelopment) {
  // start of temp data seeding
  const walletFoo = new Wallet();
  const walletBar = new Wallet();

  const generateWalletTransaction = ({ wallet, recipient, amount }) => {
    const transaction = wallet.createTransaction({
      recipient,
      amount,
      chain: blockchain.chain,
    });

    transactionPool.setTransaction(transaction);
  };

  const walletAction = () =>
    generateWalletTransaction({
      wallet,
      recipient: walletFoo.publicKey,
      amount: 5,
    });
  const walletFooAction = () =>
    generateWalletTransaction({
      wallet: walletFoo,
      recipient: walletBar.publicKey,
      amount: 10,
    });
  const wallerBarAction = () =>
    generateWalletTransaction({
      wallet: walletBar,
      recipient: wallet.publicKey,
      amount: 15,
    });

  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) {
      walletAction();
      walletFooAction();
    } else if (i % 3 === 1) {
      walletAction();
      wallerBarAction();
    } else {
      walletFooAction();
      wallerBarAction();
    }

    transactionMiner.mineTransaction();
  }
  // end of temp data seeding
}

let PEER_PORT;

if (process.env.GENERATE_PEER_PORT === "true") {
  PEER_PORT = DEFAULT_PORT + Math.ceil(Math.random() * 1000);
}
const PORT = process.env.PORT || PEER_PORT || DEFAULT_PORT;
app.listen(PORT, () => {
  console.log(`listening at localhost:${PORT}`);
  if (PORT !== DEFAULT_PORT) {
    syncWithRootState();
  }
});
