/* =====================================================================
   Sweep & Spray — Solana batch transfer console
   Runs entirely client-side. No backend. No key transmission anywhere
   except as part of a signed transaction sent to the RPC node you pick.
   ===================================================================== */

import * as web3 from "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/+esm";
import * as splToken from "https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.9/+esm";
import bs58 from "https://cdn.jsdelivr.net/npm/bs58@5.0.0/+esm";

const {
  Connection, PublicKey, Transaction, SystemProgram, Keypair,
  LAMPORTS_PER_SOL, clusterApiUrl,
} = web3;

const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, getAccount, getMint, TOKEN_PROGRAM_ID,
} = splToken;

/* ---------------------------------------------------------------- state */

const state = {
  network: "devnet",
  customRpc: "",
  connection: null,
  provider: null,          // window.solana (Phantom) once connected
  connectedPubkey: null,
  activeTab: "consolidate",
  consolidateSub: "wallet",
  cAsset: "sol",
  dAsset: "sol",
  sources: [],              // [{ pubkey, balanceLamports, status }]
  localKeypairs: [],         // [{ keypair, pubkey, balanceLamports, status }]
  recipients: [],            // [{ address, amount, valid }]
  distBatches: [],           // built Transaction[] awaiting send
};

/* ------------------------------------------------------------- helpers */

function $(id) { return document.getElementById(id); }

function short(addr) {
  if (!addr) return "";
  const s = addr.toString();
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function log(message, type = "info") {
  const body = $("ledger-body");
  const empty = body.querySelector(".ledger-empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `ledger-entry type-${type}`;
  row.innerHTML = `<span class="ledger-time">${nowStamp()}</span><span class="ledger-msg"></span>`;
  row.querySelector(".ledger-msg").innerHTML = message; // message is built internally, safe
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}

function toast(message, type = "ok") {
  const stack = $("toast-stack");
  const el = document.createElement("div");
  el.className = `toast ${type === "err" ? "err" : type === "warn" ? "warn" : ""}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function explorerLink(sig) {
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (state.network === "mainnet-beta") return base;
  if (state.network === "custom") return `${base}?cluster=custom&customUrl=${encodeURIComponent(state.customRpc)}`;
  return `${base}?cluster=${state.network}`;
}

function logTx(prefix, sig) {
  log(`${prefix} — <a href="${explorerLink(sig)}" target="_blank" rel="noopener">${short(sig)} ↗</a>`, "ok");
}

function isValidAddress(addr) {
  try { new PublicKey(addr.trim()); return true; } catch { return false; }
}

function solToLamports(x) { return Math.round(Number(x) * LAMPORTS_PER_SOL); }
function lamportsToSol(x) { return (Number(x) / LAMPORTS_PER_SOL); }
function fmt(n, dp = 4) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }); }

/* ------------------------------------------------------------- network */

function buildConnection() {
  let endpoint;
  if (state.network === "custom") {
    endpoint = state.customRpc.trim();
    if (!endpoint) { toast("Enter a custom RPC URL first", "err"); return null; }
  } else {
    endpoint = clusterApiUrl(state.network);
  }
  state.connection = new Connection(endpoint, "confirmed");
  return state.connection;
}

function updateNetBanner() {
  const banner = $("net-banner");
  banner.classList.toggle("mainnet", state.network === "mainnet-beta");
  if (state.network === "mainnet-beta") {
    banner.textContent = "⚠ Mainnet Beta selected — transactions move real funds. Double-check every address.";
  } else if (state.network === "custom") {
    banner.textContent = `Custom RPC selected — ${state.customRpc || "no endpoint set yet"}.`;
  } else {
    banner.textContent = `${state.network[0].toUpperCase()}${state.network.slice(1)} selected — safe to rehearse full sweeps and drops here before touching mainnet.`;
  }
}

$("network-select").addEventListener("change", (e) => {
  state.network = e.target.value;
  $("custom-rpc").classList.toggle("hidden", state.network !== "custom");
  updateNetBanner();
  buildConnection();
});
$("custom-rpc").addEventListener("change", (e) => {
  state.customRpc = e.target.value;
  updateNetBanner();
  if (state.network === "custom") buildConnection();
});

/* -------------------------------------------------------------- wallet */

function getProvider() {
  if ("solana" in window && window.solana.isPhantom) return window.solana;
  return null;
}

async function connectWallet() {
  const provider = getProvider();
  if (!provider) {
    toast("No Solana wallet extension found (install Phantom)", "err");
    window.open("https://phantom.app/", "_blank");
    return;
  }
  try {
    const resp = await provider.connect();
    state.provider = provider;
    state.connectedPubkey = resp.publicKey.toString();
    $("connect-label").textContent = short(state.connectedPubkey);
    $("connect-btn").classList.add("connected");
    log(`Wallet connected — <code>${state.connectedPubkey}</code>`, "ok");
    provider.on?.("accountChanged", (pk) => {
      state.connectedPubkey = pk ? pk.toString() : null;
      $("connect-label").textContent = state.connectedPubkey ? short(state.connectedPubkey) : "Connect Wallet";
      $("connect-btn").classList.toggle("connected", !!state.connectedPubkey);
      if (state.connectedPubkey) log(`Wallet switched — <code>${state.connectedPubkey}</code>`, "warn");
    });
  } catch (err) {
    toast("Wallet connection was rejected or failed", "err");
  }
}

$("connect-btn").addEventListener("click", () => {
  if (state.connectedPubkey) {
    state.provider?.disconnect?.();
    state.connectedPubkey = null;
    state.provider = null;
    $("connect-label").textContent = "Connect Wallet";
    $("connect-btn").classList.remove("connected");
    log("Wallet disconnected", "warn");
  } else {
    connectWallet();
  }
});

/* --------------------------------------------------------- tab control */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    state.activeTab = btn.dataset.tab;
    $("panel-consolidate").classList.toggle("hidden", state.activeTab !== "consolidate");
    $("panel-distribute").classList.toggle("hidden", state.activeTab !== "distribute");
    $("flow-consolidate").classList.toggle("hidden", state.activeTab !== "consolidate");
    $("flow-distribute").classList.toggle("hidden", state.activeTab !== "distribute");
  });
});

document.querySelectorAll(".sub-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sub-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.consolidateSub = btn.dataset.sub;
    $("sub-wallet").classList.toggle("hidden", state.consolidateSub !== "wallet");
    $("sub-keys").classList.toggle("hidden", state.consolidateSub !== "keys");
  });
});

/* asset toggles */
function wireAssetToggle(containerId, mintFieldId, onSet) {
  const container = $(containerId);
  container.querySelectorAll(".seg").forEach((seg) => {
    seg.addEventListener("click", () => {
      container.querySelectorAll(".seg").forEach((s) => s.classList.remove("active"));
      seg.classList.add("active");
      const asset = seg.dataset.asset;
      onSet(asset);
      $(mintFieldId).classList.toggle("hidden", asset !== "spl");
    });
  });
}
wireAssetToggle("c-asset-toggle", "c-mint", (a) => {
  state.cAsset = a;
  $("c-leave-row").classList.toggle("hidden", a !== "sol");
});
wireAssetToggle("d-asset-toggle", "d-mint", (a) => { state.dAsset = a; });

/* ===================================================================
   CONSOLIDATE — wallet-by-wallet (recommended, non-custodial)
   =================================================================== */

function renderSourceTable() {
  const body = $("c-source-body");
  body.innerHTML = "";
  state.sources.forEach((s, i) => {
    const tr = document.createElement("tr");
    const statusClass = s.status === "done" ? "status-ok" : s.status === "error" ? "status-err" : "status-pending";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="${s.pubkey}">${short(s.pubkey)}</td>
      <td>${s.balanceLamports === null ? "…" : fmt(lamportsToSol(s.balanceLamports))} SOL</td>
      <td class="${statusClass}">${s.status}</td>
      <td><button class="row-remove" data-i="${i}">✕</button></td>`;
    body.appendChild(tr);
  });
  $("c-sweep-wallets").disabled = state.sources.length === 0;
  body.querySelectorAll(".row-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sources.splice(Number(btn.dataset.i), 1);
      renderSourceTable();
    });
  });
}

$("c-add-source").addEventListener("click", async () => {
  if (!state.connectedPubkey) { toast("Connect a wallet first", "err"); return; }
  if (state.sources.some((s) => s.pubkey === state.connectedPubkey)) {
    toast("That wallet is already in the list", "warn"); return;
  }
  if (!state.connection) buildConnection();
  const pubkey = state.connectedPubkey;
  state.sources.push({ pubkey, balanceLamports: null, status: "queued" });
  renderSourceTable();
  try {
    const bal = await state.connection.getBalance(new PublicKey(pubkey));
    const entry = state.sources.find((s) => s.pubkey === pubkey);
    if (entry) entry.balanceLamports = bal;
    renderSourceTable();
    log(`Added source <code>${pubkey}</code> — balance ${fmt(lamportsToSol(bal))} SOL`);
  } catch (err) {
    log(`Failed to fetch balance for ${short(pubkey)}: ${err.message}`, "err");
  }
});

async function sweepOneSource(source) {
  const destStr = $("c-destination").value.trim();
  if (!isValidAddress(destStr)) { toast("Enter a valid destination address", "err"); return false; }
  const dest = new PublicKey(destStr);
  const from = new PublicKey(source.pubkey);
  const conn = state.connection || buildConnection();
  const RESERVE_LAMPORTS = 5000; // base tx fee reserve
  const EXTRA_RENT_BUFFER = $("c-leave-rent").checked ? Math.round(0.001 * LAMPORTS_PER_SOL) : 0;

  try {
    source.status = "signing…"; renderSourceTable();

    if (state.cAsset === "sol") {
      const balance = await conn.getBalance(from);
      const sendable = balance - RESERVE_LAMPORTS - EXTRA_RENT_BUFFER;
      if (sendable <= 0) {
        source.status = "insufficient balance"; renderSourceTable();
        log(`Skipped <code>${short(source.pubkey)}</code> — balance too low to cover fee/reserve`, "warn");
        return false;
      }
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: sendable }));
      tx.feePayer = from;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await state.provider.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      source.status = "done"; source.balanceLamports = RESERVE_LAMPORTS + EXTRA_RENT_BUFFER;
      renderSourceTable();
      logTx(`Swept ${fmt(lamportsToSol(sendable))} SOL from ${short(source.pubkey)} → ${short(destStr)}`, sig);
      return true;
    } else {
      const mintStr = $("c-mint").value.trim();
      if (!isValidAddress(mintStr)) { toast("Enter a valid SPL token mint", "err"); return false; }
      const mint = new PublicKey(mintStr);
      const mintInfo = await getMint(conn, mint);
      const fromAta = await getAssociatedTokenAddress(mint, from);
      const toAta = await getAssociatedTokenAddress(mint, dest);
      const acct = await getAccount(conn, fromAta).catch(() => null);
      if (!acct || acct.amount === 0n) {
        source.status = "no token balance"; renderSourceTable();
        log(`Skipped <code>${short(source.pubkey)}</code> — no balance for this token`, "warn");
        return false;
      }
      const ixs = [];
      const toAtaInfo = await conn.getAccountInfo(toAta);
      if (!toAtaInfo) {
        ixs.push(createAssociatedTokenAccountInstruction(from, toAta, dest, mint));
      }
      ixs.push(createTransferInstruction(fromAta, toAta, from, acct.amount, [], TOKEN_PROGRAM_ID));
      const tx = new Transaction().add(...ixs);
      tx.feePayer = from;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await state.provider.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      source.status = "done";
      renderSourceTable();
      const human = Number(acct.amount) / (10 ** mintInfo.decimals);
      logTx(`Swept ${fmt(human)} tokens from ${short(source.pubkey)} → ${short(destStr)}`, sig);
      return true;
    }
  } catch (err) {
    source.status = "error"; renderSourceTable();
    log(`Error sweeping ${short(source.pubkey)}: ${err.message}`, "err");
    return false;
  }
}

$("c-sweep-wallets").addEventListener("click", async () => {
  if (!state.connection) buildConnection();
  for (const source of state.sources) {
    if (source.status === "done") continue;
    if (!state.connectedPubkey || state.connectedPubkey !== source.pubkey) {
      toast(`Switch your wallet extension to ${short(source.pubkey)}, then click "Sweep sources" again`, "warn");
      log(`Waiting for wallet switch to <code>${source.pubkey}</code> — reconnect that wallet, then click Sweep again`, "warn");
      return;
    }
    const ok = await sweepOneSource(source);
    if (!ok) return; // stop on first failure so nothing runs unattended
  }
  toast("All sources swept", "ok");
});

/* ===================================================================
   CONSOLIDATE — import local keys (advanced)
   =================================================================== */

function parseSecretKeyLine(line) {
  const t = line.trim();
  if (!t) return null;
  try {
    if (t.startsWith("[")) {
      const arr = JSON.parse(t);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(t));
  } catch {
    return null;
  }
}

function renderKeyTable() {
  const body = $("c-key-body");
  body.innerHTML = "";
  state.localKeypairs.forEach((k, i) => {
    const tr = document.createElement("tr");
    const statusClass = k.status === "done" ? "status-ok" : k.status === "error" ? "status-err" : "status-pending";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="${k.pubkey}">${short(k.pubkey)}</td>
      <td>${k.balanceLamports === null ? "…" : fmt(lamportsToSol(k.balanceLamports))} SOL</td>
      <td class="${statusClass}">${k.status}</td>`;
    body.appendChild(tr);
  });
  const ready = state.localKeypairs.length > 0;
  $("c-confirm-row").classList.toggle("hidden", !ready);
}

$("c-load-keys").addEventListener("click", async () => {
  const lines = $("c-key-input").value.split("\n");
  const parsed = [];
  let failCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const kp = parseSecretKeyLine(line);
    if (kp) parsed.push({ keypair: kp, pubkey: kp.publicKey.toString(), balanceLamports: null, status: "queued" });
    else failCount++;
  }
  if (failCount > 0) toast(`${failCount} line(s) could not be parsed as a secret key`, "warn");
  state.localKeypairs = parsed;
  renderKeyTable();
  if (!state.connection) buildConnection();
  for (const k of state.localKeypairs) {
    try {
      k.balanceLamports = await state.connection.getBalance(k.keypair.publicKey);
    } catch (err) {
      k.status = "error";
    }
  }
  renderKeyTable();
  log(`Loaded ${state.localKeypairs.length} local wallet(s) for consolidation`, "ok");
});

$("c-confirm-text").addEventListener("input", (e) => {
  $("c-sweep-keys").disabled = e.target.value.trim() !== "SWEEP" || state.localKeypairs.length === 0;
});

$("c-sweep-keys").addEventListener("click", async () => {
  const destStr = $("c-destination").value.trim();
  if (!isValidAddress(destStr)) { toast("Enter a valid destination address", "err"); return; }
  const dest = new PublicKey(destStr);
  const conn = state.connection || buildConnection();
  const RESERVE_LAMPORTS = 5000;
  const EXTRA_RENT_BUFFER = $("c-leave-rent").checked ? Math.round(0.001 * LAMPORTS_PER_SOL) : 0;

  $("c-sweep-keys").disabled = true;
  for (const k of state.localKeypairs) {
    if (k.status === "done") continue;
    try {
      k.status = "signing…"; renderKeyTable();
      if (state.cAsset === "sol") {
        const balance = await conn.getBalance(k.keypair.publicKey);
        const sendable = balance - RESERVE_LAMPORTS - EXTRA_RENT_BUFFER;
        if (sendable <= 0) { k.status = "insufficient"; renderKeyTable(); continue; }
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: k.keypair.publicKey, toPubkey: dest, lamports: sendable }));
        tx.feePayer = k.keypair.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.sign(k.keypair);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, "confirmed");
        k.status = "done"; renderKeyTable();
        logTx(`Swept ${fmt(lamportsToSol(sendable))} SOL from ${short(k.pubkey)} → ${short(destStr)}`, sig);
      } else {
        const mintStr = $("c-mint").value.trim();
        if (!isValidAddress(mintStr)) { toast("Enter a valid SPL token mint", "err"); break; }
        const mint = new PublicKey(mintStr);
        const fromAta = await getAssociatedTokenAddress(mint, k.keypair.publicKey);
        const toAta = await getAssociatedTokenAddress(mint, dest);
        const acct = await getAccount(conn, fromAta).catch(() => null);
        if (!acct || acct.amount === 0n) { k.status = "no balance"; renderKeyTable(); continue; }
        const ixs = [];
        const toAtaInfo = await conn.getAccountInfo(toAta);
        if (!toAtaInfo) ixs.push(createAssociatedTokenAccountInstruction(k.keypair.publicKey, toAta, dest, mint));
        ixs.push(createTransferInstruction(fromAta, toAta, k.keypair.publicKey, acct.amount, [], TOKEN_PROGRAM_ID));
        const tx = new Transaction().add(...ixs);
        tx.feePayer = k.keypair.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.sign(k.keypair);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, "confirmed");
        k.status = "done"; renderKeyTable();
        logTx(`Swept tokens from ${short(k.pubkey)} → ${short(destStr)}`, sig);
      }
    } catch (err) {
      k.status = "error"; renderKeyTable();
      log(`Error sweeping ${short(k.pubkey)}: ${err.message}`, "err");
    }
  }
  toast("Local sweep run finished — check ledger for details", "ok");
});

/* ===================================================================
   DISTRIBUTE — one wallet → many recipients
   =================================================================== */

$("d-csv-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 2) continue;
    if (!isValidAddress(parts[0]) && out.length === 0) continue; // skip header row
    out.push(`${parts[0].trim()},${parts[1].trim()}`);
  }
  $("d-recipients").value = out.join("\n");
  toast(`Loaded ${out.length} row(s) from CSV`, "ok");
});

$("d-parse").addEventListener("click", () => {
  const lines = $("d-recipients").value.split("\n").map((l) => l.trim()).filter(Boolean);
  state.recipients = lines.map((line) => {
    const [addr, amt] = line.split(",").map((s) => (s || "").trim());
    const valid = isValidAddress(addr) && Number(amt) > 0;
    return { address: addr, amount: Number(amt), valid };
  });
  renderRecipientPreview();
});

function renderRecipientPreview() {
  $("d-preview-block").style.display = state.recipients.length ? "block" : "none";
  const body = $("d-preview-body");
  body.innerHTML = "";
  let total = 0, validCount = 0;
  state.recipients.forEach((r, i) => {
    if (r.valid) { total += r.amount; validCount++; }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="${r.address}">${short(r.address)}</td>
      <td>${fmt(r.amount)}</td>
      <td class="${r.valid ? "status-ok" : "status-err"}">${r.valid ? "ok" : "invalid"}</td>`;
    body.appendChild(tr);
  });
  const unit = state.dAsset === "sol" ? "SOL" : "tokens";
  const perTxCount = state.dAsset === "sol" ? 20 : 8;
  const batches = Math.ceil(validCount / perTxCount) || 0;
  const estFee = batches * 0.000015; // rough: 3 sigs-worth per batch, generous estimate
  $("d-summary").innerHTML =
    `<span>Valid recipients: <b>${validCount}/${state.recipients.length}</b></span>` +
    `<span>Total: <b>${fmt(total)} ${unit}</b></span>` +
    `<span>Batches (~${perTxCount}/tx): <b>${batches}</b></span>` +
    `<span>Est. network fees: <b>~${fmt(estFee, 6)} SOL</b></span>`;
  $("d-send").disabled = validCount === 0;
}

function buildDistributionBatches() {
  const valid = state.recipients.filter((r) => r.valid);
  const perTxCount = state.dAsset === "sol" ? 20 : 8;
  const chunks = [];
  for (let i = 0; i < valid.length; i += perTxCount) chunks.push(valid.slice(i, i + perTxCount));
  return chunks;
}

async function buildTxForChunk(chunk, mintPubkey, mintDecimals) {
  const conn = state.connection || buildConnection();
  const from = new PublicKey(state.connectedPubkey);
  const tx = new Transaction();
  if (state.dAsset === "sol") {
    for (const r of chunk) {
      tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(r.address), lamports: solToLamports(r.amount) }));
    }
  } else {
    const fromAta = await getAssociatedTokenAddress(mintPubkey, from);
    for (const r of chunk) {
      const toPub = new PublicKey(r.address);
      const toAta = await getAssociatedTokenAddress(mintPubkey, toPub);
      const info = await conn.getAccountInfo(toAta);
      if (!info) tx.add(createAssociatedTokenAccountInstruction(from, toAta, toPub, mintPubkey));
      const rawAmount = BigInt(Math.round(r.amount * (10 ** mintDecimals)));
      tx.add(createTransferInstruction(fromAta, toAta, from, rawAmount, [], TOKEN_PROGRAM_ID));
    }
  }
  tx.feePayer = from;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return tx;
}

$("d-simulate").addEventListener("click", async () => {
  if (!state.connectedPubkey) { toast("Connect a wallet first", "err"); return; }
  if (!state.recipients.some((r) => r.valid)) { toast("Parse a valid recipient list first", "err"); return; }
  try {
    const conn = state.connection || buildConnection();
    let mintPubkey = null, decimals = 9;
    if (state.dAsset === "spl") {
      const mintStr = $("d-mint").value.trim();
      if (!isValidAddress(mintStr)) { toast("Enter a valid token mint", "err"); return; }
      mintPubkey = new PublicKey(mintStr);
      decimals = (await getMint(conn, mintPubkey)).decimals;
    }
    const chunks = buildDistributionBatches();
    const tx = await buildTxForChunk(chunks[0], mintPubkey, decimals);
    const sim = await conn.simulateTransaction(tx, undefined, undefined);
    if (sim.value.err) {
      log(`Simulation failed on first batch: <code>${JSON.stringify(sim.value.err)}</code>`, "err");
      toast("Simulation reported an error — check ledger", "err");
    } else {
      log(`Simulation of first batch (${chunks[0].length} recipients) succeeded — ${sim.value.unitsConsumed ?? "?"} compute units`, "ok");
      toast("Simulation succeeded", "ok");
    }
  } catch (err) {
    log(`Simulation error: ${err.message}`, "err");
    toast("Simulation failed", "err");
  }
});

$("d-send").addEventListener("click", async () => {
  if (!state.connectedPubkey) { toast("Connect a wallet first", "err"); return; }
  if (!confirm(`Send to ${state.recipients.filter(r => r.valid).length} recipient(s) on ${state.network}? This cannot be undone.`)) return;

  try {
    const conn = state.connection || buildConnection();
    let mintPubkey = null, decimals = 9;
    if (state.dAsset === "spl") {
      const mintStr = $("d-mint").value.trim();
      if (!isValidAddress(mintStr)) { toast("Enter a valid token mint", "err"); return; }
      mintPubkey = new PublicKey(mintStr);
      decimals = (await getMint(conn, mintPubkey)).decimals;
    }
    const chunks = buildDistributionBatches();
    $("d-send").disabled = true;
    log(`Starting distribution — ${chunks.length} batch(es)`, "warn");
    for (let i = 0; i < chunks.length; i++) {
      const tx = await buildTxForChunk(chunks[i], mintPubkey, decimals);
      const signed = await state.provider.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      logTx(`Batch ${i + 1}/${chunks.length} sent (${chunks[i].length} recipients)`, sig);
    }
    toast("Distribution complete", "ok");
    log("Distribution run complete.", "ok");
  } catch (err) {
    log(`Distribution stopped: ${err.message}`, "err");
    toast("Distribution failed — check ledger", "err");
  } finally {
    $("d-send").disabled = false;
  }
});

/* ===================================================================
   flow diagram (decorative signature element)
   =================================================================== */

function buildFlow(svgId, mode) {
  const svg = $(svgId);
  const g = svg.querySelector(".flow-nodes");
  g.innerHTML = "";
  const nSources = 5;
  const cx = mode === "consolidate" ? 780 : 120;
  const cy = 110;
  const leftX = mode === "consolidate" ? 120 : 780;
  const spacing = 180 / (nSources - 1);

  for (let i = 0; i < nSources; i++) {
    const y = 30 + i * spacing * 2.2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midX = (cx + leftX) / 2;
    const d = `M ${leftX} ${y} C ${midX} ${y}, ${midX} ${cy}, ${cx} ${cy}`;
    path.setAttribute("d", d);
    path.setAttribute("class", "flow-line");
    path.setAttribute("stroke", i % 2 === 0 ? "#9945FF" : "#14F195");
    path.setAttribute("stroke-opacity", "0.55");
    path.style.animationDelay = `${i * 0.12}s`;
    g.appendChild(path);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", leftX); circle.setAttribute("cy", y); circle.setAttribute("r", "9");
    circle.setAttribute("class", "flow-node-circle");
    g.appendChild(circle);
  }
  const hub = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hub.setAttribute("cx", cx); hub.setAttribute("cy", cy); hub.setAttribute("r", "14");
  hub.setAttribute("fill", "url(#g1)");
  g.appendChild(hub);

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", cx); label.setAttribute("y", cy + 34);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "flow-node-label");
  label.textContent = mode === "consolidate" ? "destination" : "source";
  g.appendChild(label);
}

buildFlow("flow-consolidate", "consolidate");
buildFlow("flow-distribute", "distribute");

/* ===================================================================
   misc wiring
   =================================================================== */

$("ledger-clear").addEventListener("click", () => {
  $("ledger-body").innerHTML = '<div class="ledger-empty">No activity yet. Actions and transaction signatures will be logged here as they happen.</div>';
});

updateNetBanner();
buildConnection();
renderSourceTable();
renderKeyTable();
