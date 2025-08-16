// /netlify/functions/fetch-memes.ts
import { Connection, PublicKey } from "@solana/web3.js";

export const handler = async (event) => {
  try {
    const RPC = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";
    const REGISTRY = process.env.PUBLISH_REGISTRY!;

    const connection = new Connection(RPC, "confirmed");
    const pubkey = new PublicKey(REGISTRY);

    // Get recent signatures
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 20 });

    // Get parsed txs
    const txs = await connection.getParsedTransactions(
      sigs.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    // Extract memos
    const memes = txs
      ?.map((tx) => {
        const memo = tx?.transaction.message.instructions.find(
          (ix: any) => ix.program === "spl-memo"
        );
        return memo?.parsed || null;
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      body: JSON.stringify({ memes }),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "max-age=30", // cache 30s to ease RPC load
      },
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
