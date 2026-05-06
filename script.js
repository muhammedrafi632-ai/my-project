const CSV_URL     = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKJrZEW_VHDU987NKqyi3dcc5gspCCXjnnyL0INxJ-16DP1-pUTaBeXttRn9Ys6w/pub?output=csv';
const GRN_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKJrZEW_VHDU987NKqyi3dcc5gspCCXjnnyL0INxJ-16DP1-pUTaBeXttRn9Ys6w/pub?output=csv&gid=1571662947';

let rawData  = [];
let grnData  = [];
let filtered = [];

document.addEventListener('DOMContentLoaded', () => {
    fetchData();
    document.getElementById('searchInput').addEventListener('input', (e) => applyFilters());
    window.addEventListener('scroll', toggleScrollButtonState);
    toggleScrollButtonState();
});

// ── FETCH ──────────────────────────────────────────────────────────────────
async function fetchData() {
    try {
        const [res1, res2] = await Promise.all([
            fetch(CSV_URL,     { cache: "no-cache" }),
            fetch(GRN_CSV_URL, { cache: "no-cache" })
        ]);
        if (!res1.ok) throw new Error('Google Sheets connection failed.');

        const [csv1, csv2] = await Promise.all([res1.text(), res2.ok ? res2.text() : Promise.resolve('')]);

        Papa.parse(csv1, {
            header: true, skipEmptyLines: 'greedy',
            complete: (r1) => {
                // Normalize and load order data

                rawData = r1.data.filter(row => {
                    const po = getField(row, ['PO', 'PO NO.', 'PO NO']) || Object.values(row)[1];
                    return po && !String(po).includes('#REF!') && String(po).trim() !== '';
                });

                if (csv2) {
                    Papa.parse(csv2, {
                        header: true, skipEmptyLines: 'greedy',
                        complete: (r2) => {
                            grnData = r2.data;
                            finalize();
                        }
                    });
                } else {
                    finalize();
                }
            }
        });
    } catch (err) {
        console.error(err);
        showError("Could not connect to Google Sheets. Try Incognito mode or disable AdBlock.");
    }
}

function finalize() {
    if (!rawData.length) { showError("Sheet loaded but no data found."); return; }
    filtered = rawData;
    renderTable(filtered);
    updateStats(filtered);
    renderInsights(filtered);
    renderSupplierDueList(filtered);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('lastUpdated').textContent =
        'Last updated: ' + new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ── STATS ──────────────────────────────────────────────────────────────────
function updateStats(data) {
    const orderQty = data.reduce((s, r) => s + parseNumber(getField(r, ['QTY ORDERED']) || 0), 0);
    const receivedQty = data.reduce((s, r) => s + parseNumber(getField(r, ['QTY RECEIVED', 'QTY RECD']) || 0), 0);
    const orderVal = data.reduce((s, r) => s + parseSAR(getField(r, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0), 0);
    const receivedVal = data.reduce((s, r) => s + parseSAR(getField(r, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0), 0);
    const balanceVal = orderVal - receivedVal;
    const vendors = new Set(data.map(r => getField(r, ['VENDOR CODE'])).filter(Boolean)).size;

    document.getElementById('stat-total-pos').textContent = data.length.toLocaleString();
    document.getElementById('stat-order-qty').textContent = formatQty(orderQty);
    document.getElementById('stat-received-qty').textContent = formatQty(receivedQty);
    document.getElementById('stat-order-value').textContent = 'SAR ' + formatMoney(orderVal);
    document.getElementById('stat-received-value').textContent = 'SAR ' + formatMoney(receivedVal);
    document.getElementById('stat-balance-value').textContent = 'SAR ' + formatMoney(balanceVal);
    document.getElementById('stat-vendors').textContent = vendors.toLocaleString();
    document.getElementById('row-count').textContent = data.length.toLocaleString() + ' records';
}

// ── TABLE ──────────────────────────────────────────────────────────────────
function renderTable(data) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    data.forEach((row) => {
        const date = getField(row, ['PO DATE']) || '-';
        const po = getField(row, ['PO', 'PO NO.', 'PO NO']) || '-';
        const vendor = getField(row, ['VENDOR CODE']) || '-';
        const supplier = getField(row, ['SUPPLIER NAME']) || '-';
        const rmCode = getField(row, ['RM CODE']) || '-';
        const category = categorizeRMCode(rmCode);
        const name = getField(row, ['RM NAME']) || '-';
        const qtyOrd = parseNumber(getField(row, ['QTY ORDERED']) || 0);
        const qtyRec = parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0);
        const qtyBal = parseNumber(getField(row, ['QTY BALANCE']) || 0) || (qtyOrd - qtyRec);
        const orderVal = parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
        const receivedVal = parseSAR(getField(row, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0);

        // Status badge
        const pct = qtyOrd > 0 ? (qtyRec / qtyOrd) * 100 : 0;
        let statusBadge;
        if (pct >= 100)      statusBadge = `<span class="badge badge-green">Fully Received</span>`;
        else if (pct > 0)    statusBadge = `<span class="badge badge-amber">Partial ${Math.round(pct)}%</span>`;
        else                 statusBadge = `<span class="badge badge-slate">Pending</span>`;

        // Progress bar
        const progressBar = `<div class="progress-bar mt-1"><div class="progress-fill ${pct>=100?'bg-emerald-500':pct>0?'bg-amber-400':'bg-slate-200'}" style="width:${Math.min(pct,100)}%"></div></div>`;

        // GRN match
        const grns = getMatchingGrns(po, name);
        const hasGrn = grns.length > 0;

        const tr = document.createElement('tr');
        tr.className = 'table-row cursor-pointer';

        tr.innerHTML = `
            <td class="px-5 py-3.5 text-sm text-slate-500 whitespace-nowrap">${date}</td>
            <td class="px-5 py-3.5 text-sm font-bold text-blue-600 whitespace-nowrap">${po}</td>
            <td class="px-5 py-3.5 text-sm"><span class="vendor-chip">${vendor}</span></td>
            <td class="px-5 py-3.5 text-sm text-slate-600 max-w-[180px] truncate" title="${supplier}">${supplier}</td>
            <td class="px-5 py-3.5 text-sm"><span class="rm-code-chip">${rmCode}</span></td>
            <td class="px-5 py-3.5 text-sm"><span class="category-chip">${category}</span></td>
            <td class="px-5 py-3.5 text-sm font-medium max-w-[220px] truncate" title="${name}">${name}</td>
            <td class="px-5 py-3.5 text-sm text-right font-semibold">${qtyOrd.toLocaleString()}</td>
            <td class="px-5 py-3.5 text-sm text-right text-emerald-600 font-semibold">${qtyRec.toLocaleString()}</td>
            <td class="px-5 py-3.5 text-sm text-right text-amber-600 font-semibold">${qtyBal.toLocaleString()}</td>
            <td class="px-5 py-3.5 text-sm text-right font-semibold text-indigo-700">
                ${orderVal > 0 ? formatMoney(orderVal) : '-'}
            </td>
            <td class="px-5 py-3.5 text-sm text-right font-semibold text-emerald-700">
                ${receivedVal > 0 ? formatMoney(receivedVal) : '-'}
            </td>
            <td class="px-5 py-3.5 text-center">${statusBadge}${progressBar}</td>
            <td class="px-5 py-3.5 text-center">
                ${hasGrn
                    ? `<button class="grn-toggle-btn"><i class="fas fa-chevron-down grn-icon transition-transform duration-200"></i></button>`
                    : `<span class="text-slate-300 text-xs">—</span>`}
            </td>
        `;
        tbody.appendChild(tr);

        // GRN expansion row
        if (hasGrn) {
            const detailTr = document.createElement('tr');
            detailTr.className = 'grn-details-row hidden';

            const cards = grns.flatMap(extractGrnCards);
            const uniqueCards = dedupeGrnCards(cards);
            const grnTotalQty = uniqueCards.reduce((sum, card) => sum + parseNumber(card.qty || 0), 0);
            const receivedSheetQty = grns.reduce((sum, row) => sum + parseNumber(getField(row, ['Qty Recd', 'QTY RECD']) || 0), 0);

            if (uniqueCards.length === 0 && receivedSheetQty === 0) {
                detailTr.innerHTML = `<td colspan="14" class="px-5 py-3 text-xs text-slate-400 italic bg-slate-50">No GRN entries found.</td>`;
            } else {
                const cardHtml = uniqueCards.map(c => `
                    <div class="grn-card">
                        <div class="text-xs text-slate-500 font-medium mb-1">GRN # <span class="text-slate-700 font-bold">${c.no || 'Receipt'}</span></div>
                        <div class="text-lg font-bold text-emerald-600">${formatQty(parseNumber(c.qty || 0))}</div>
                        <div class="text-xs text-slate-400 mt-0.5">${c.dt || '-'}</div>
                    </div>`).join('');
                detailTr.innerHTML = `
                    <td colspan="14" class="px-5 py-4 bg-slate-50 border-t border-slate-100">
                        <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-3">
                            <div>
                                <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">GRN Receipts for PO ${po}</p>
                                <p class="text-sm font-semibold text-slate-700 mt-1">${name}</p>
                            </div>
                            <div class="grn-summary-wrap">
                                <span class="grn-summary-chip">Received Qty: ${formatQty(receivedSheetQty || qtyRec)}</span>
                                <span class="grn-summary-chip">GRN Total: ${formatQty(grnTotalQty || receivedSheetQty || qtyRec)}</span>
                                <span class="grn-summary-chip">Entries: ${uniqueCards.length || grns.length}</span>
                            </div>
                        </div>
                        <div class="flex flex-wrap gap-3">${cardHtml || `<div class="text-sm text-slate-500">Total received: ${formatQty(receivedSheetQty || qtyRec)}</div>`}</div>
                    </td>`;
            }
            tbody.appendChild(detailTr);

            tr.querySelector('.grn-toggle-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const icon = tr.querySelector('.grn-icon');
                detailTr.classList.toggle('hidden');
                icon.style.transform = detailTr.classList.contains('hidden') ? '' : 'rotate(180deg)';
            });
        }
    });
}

// ── FILTERS ────────────────────────────────────────────────────────────────
function applyFilters() {
    const q    = document.getElementById('searchInput').value.toLowerCase();
    const from = document.getElementById('dateFrom').value;
    const to   = document.getElementById('dateTo').value;

    const fromDate = parseInputDate(from, false);
    const toDate = parseInputDate(to, true);

    filtered = rawData.filter(row => {
        const matchSearch = !q || Object.values(row).some(v => String(v).toLowerCase().includes(q));
        const rowDate = parseDate(getField(row, ['PO DATE']));
        const matchFrom = !fromDate || !rowDate || rowDate >= fromDate;
        const matchTo   = !toDate || !rowDate || rowDate <= toDate;
        return matchSearch && matchFrom && matchTo;
    });

    renderTable(filtered);
    updateStats(filtered);
    renderInsights(filtered);
    renderSupplierDueList(filtered);
}

function applyDateFilter() { applyFilters(); }

function clearDateFilter() {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value   = '';
    applyFilters();
}

function scrollPageTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollPageBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function scrollToBottom() {
    scrollPageBottom();
}

function getTableScroller() {
    return document.getElementById('tableScroller');
}

function scrollTableLeft() {
    const scroller = getTableScroller();
    if (!scroller) return;
    scroller.scrollBy({ left: -350, behavior: 'smooth' });
}

function scrollTableRight() {
    const scroller = getTableScroller();
    if (!scroller) return;
    scroller.scrollBy({ left: 350, behavior: 'smooth' });
}

function scrollTableToStart() {
    const scroller = getTableScroller();
    if (!scroller) return;
    scroller.scrollTo({ left: 0, behavior: 'smooth' });
}

function scrollTableToEnd() {
    const scroller = getTableScroller();
    if (!scroller) return;
    scroller.scrollTo({ left: scroller.scrollWidth, behavior: 'smooth' });
}

function toggleScrollButtonState() {
    const upBtn = document.getElementById('dockUpBtn');
    const downBtn = document.getElementById('dockDownBtn');
    if (!upBtn || !downBtn) return;

    const nearTop = window.scrollY < 80;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;

    upBtn.classList.toggle('dock-disabled', nearTop);
    downBtn.classList.toggle('dock-disabled', nearBottom);
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function parseNumber(val) {
    if (val === null || val === undefined || val === '') return 0;
    return parseFloat(String(val).replace(/[^0-9.\-]/g, '')) || 0;
}

function parseSAR(val) {
    return parseNumber(val);
}

function formatMoney(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatQty(n) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function parseDate(str) {
    if (!str) return null;

    const clean = String(str).trim();

    if (/^\d+$/.test(clean)) {
        const serial = parseInt(clean, 10);
        if (serial > 59) {
            const excelEpoch = new Date(1899, 11, 30);
            const date = new Date(excelEpoch.getTime() + serial * 86400000);
            return Number.isNaN(date.getTime()) ? null : date;
        }
    }

    const slashParts = clean.split('/');
    const dotParts = clean.split('.');
    const dashParts = clean.split('-');

    if (slashParts.length === 3) return new Date(slashParts[2], slashParts[1] - 1, slashParts[0]);
    if (dotParts.length === 3) {
        const year = dotParts[2].length === 2 ? `20${dotParts[2]}` : dotParts[2];
        return new Date(year, dotParts[1] - 1, dotParts[0]);
    }

    if (dashParts.length === 3 && dashParts[0].length === 4) {
        const date = new Date(dashParts[0], dashParts[1] - 1, dashParts[2]);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (dashParts.length === 3) {
        const year = dashParts[2].length === 2 ? `20${dashParts[2]}` : dashParts[2];
        const date = new Date(year, dashParts[1] - 1, dashParts[0]);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(clean);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseInputDate(value, endOfDay) {
    if (!value) return null;
    const parts = String(value).split('-');
    if (parts.length !== 3) return null;

    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    if (Number.isNaN(date.getTime())) return null;

    if (endOfDay) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);

    return date;
}

function normalizeKey(key) {
    return String(key || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function categorizeRMCode(code) {
    const value = String(code || '').trim().toUpperCase();

    if (!value || value === '-') return 'Uncategorized';
    if (value.startsWith('CSA')) return 'Accessories';
    if (value.startsWith('TD')) return 'Container - Drum';
    if (value.startsWith('TG')) return 'Container - Gallon';
    if (value.startsWith('TB')) return 'Container - Barrel';
    if (value.startsWith('RA')) return 'Additive';
    if (value.startsWith('RP')) return 'Pigments';
    if (value.startsWith('RS')) return 'Solvent';
    if (value.startsWith('RR')) return 'Resin';
    if (value.startsWith('R')) return 'Raw Material';

    return 'Other';
}

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getField(obj, keys) {
    const entries = Object.entries(obj || {});
    for (const wanted of keys) {
        const match = entries.find(([key, value]) => normalizeKey(key) === normalizeKey(wanted) && value !== undefined && String(value).trim() !== '');
        if (match) return match[1];
    }
    return null;
}

function getMatchingGrns(po, materialName) {
    const poMatches = grnData.filter(g => String(getField(g, ['PO NO.', 'PO NO', 'PO']) || '').trim() === String(po).trim());
    const normalizedMaterial = normalizeText(materialName);

    if (!normalizedMaterial) return poMatches;

    const exactMaterialMatches = poMatches.filter(g => {
        const grnMaterial = normalizeText(getField(g, ['Rm Name', 'RM NAME', 'RM Name']) || '');
        return grnMaterial && (grnMaterial.includes(normalizedMaterial) || normalizedMaterial.includes(grnMaterial));
    });

    return exactMaterialMatches.length ? exactMaterialMatches : poMatches;
}

function extractGrnCards(row) {
    const entries = Object.entries(row || {});
    const cards = [];
    let current = null;

    for (const [key, value] of entries) {
        const normalized = normalizeKey(key);
        const cleanValue = value === undefined || value === null ? '' : String(value).trim();

        if (normalized.startsWith('grn no')) {
            if (current && (current.no || current.dt || current.qty)) cards.push(current);
            current = { no: cleanValue, dt: '', qty: '' };
            continue;
        }

        if (!current) continue;

        if (normalized.startsWith('grn dt')) {
            current.dt = cleanValue;
            continue;
        }

        if (normalized.startsWith('grn qty')) {
            current.qty = cleanValue;
        }
    }

    if (current && (current.no || current.dt || current.qty)) cards.push(current);

    if (!cards.length) {
        const qtyRecd = parseNumber(getField(row, ['Qty Recd', 'QTY RECD']) || 0);
        if (qtyRecd > 0) {
            cards.push({ no: 'Summary', dt: getField(row, ['PO Date', 'PO DATE']) || '', qty: qtyRecd });
        }
    }

    return cards;
}

function dedupeGrnCards(cards) {
    const seen = new Set();
    return cards.filter(card => {
        const key = `${card.no}|${card.dt}|${card.qty}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function summarizeMaterials(data) {
    const summary = new Map();

    data.forEach(row => {
        const rmCode = getField(row, ['RM CODE']) || '';
        const name = getField(row, ['RM NAME']) || 'Unknown Material';
        const category = categorizeRMCode(rmCode);
        const ordered = parseNumber(getField(row, ['QTY ORDERED']) || 0);
        const received = parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0);
        const value = parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
        const key = `${rmCode}__${name}`;

        if (!summary.has(key)) {
            summary.set(key, { rmCode, name, category, ordered: 0, received: 0, value: 0 });
        }

        const item = summary.get(key);
        item.ordered += ordered;
        item.received += received;
        item.value += value;
    });

    return Array.from(summary.values());
}

function renderMaterialList(containerId, items, type) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!items.length) {
        el.innerHTML = '<p class="text-sm text-slate-400">No material data available.</p>';
        return;
    }

    el.innerHTML = items.slice(0, 5).map((item, index) => {
        const primary = type === 'ordered' ? item.ordered : item.received;
        const secondary = type === 'ordered' ? item.received : item.ordered;
        return `
            <div class="material-row">
                <div class="material-rank">${index + 1}</div>
                <div class="material-main">
                    <div class="material-name">${item.name}</div>
                    <div class="material-sub">${item.rmCode || '-'} • ${item.category}</div>
                    <div class="material-sub">Ordered ${formatQty(item.ordered)} • Received ${formatQty(item.received)}</div>
                </div>
                <div class="material-metric">
                    <div class="material-qty">${formatQty(primary)}</div>
                    <div class="material-sub">${type === 'ordered' ? 'ordered' : 'received'}</div>
                </div>
            </div>`;
    }).join('');
}

function renderInsights(data) {
    const summary = summarizeMaterials(data);
    const topOrdered = [...summary].sort((a, b) => b.ordered - a.ordered);
    const topReceived = [...summary].sort((a, b) => b.received - a.received);

    renderMaterialList('topOrderedMaterials', topOrdered, 'ordered');
    renderMaterialList('topReceivedMaterials', topReceived, 'received');
}

function calculateDueAmount(row) {
    const qtyOrdered = parseNumber(getField(row, ['QTY ORDERED']) || 0);
    const qtyReceived = parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0);
    const qtyBalanceField = getField(row, ['QTY BALANCE']);
    const qtyBalance = qtyBalanceField !== null ? parseNumber(qtyBalanceField) : (qtyOrdered - qtyReceived);

    const orderValue = parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
    const receivedValue = parseSAR(getField(row, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0);

    if (orderValue > 0 || receivedValue > 0) {
        const balanceValue = orderValue - receivedValue;
        if (balanceValue > 0) return balanceValue;
    }

    if (qtyBalance > 0 && qtyOrdered > 0 && orderValue > 0) {
        const unitValue = orderValue / qtyOrdered;
        return qtyBalance * unitValue;
    }

    return 0;
}

function getSupplierDuePriority(rank, totalRows) {
    if (totalRows <= 3) {
        if (rank === 0) return 'High';
        if (rank === 1) return 'Medium';
        return 'Low';
    }

    const percentile = (rank + 1) / totalRows;
    if (percentile <= 0.2) return 'High';
    if (percentile <= 0.6) return 'Medium';
    return 'Low';
}

function summarizeSupplierDues(data) {
    const summary = new Map();

    data.forEach(row => {
        const vendorCode = String(getField(row, ['VENDOR CODE']) || '').trim() || 'Others';
        const supplierName = String(getField(row, ['SUPPLIER NAME']) || '').trim() || 'Others';
        const dueAmount = calculateDueAmount(row);

        if (dueAmount <= 0) return;

        const key = `${vendorCode}__${supplierName}`;
        if (!summary.has(key)) {
            summary.set(key, { vendorCode, supplierName, dueAmount: 0 });
        }

        summary.get(key).dueAmount += dueAmount;
    });

    return Array.from(summary.values()).sort((a, b) => b.dueAmount - a.dueAmount);
}

function renderSupplierDueList(data) {
    const tbody = document.getElementById('supplierDueListBody');
    if (!tbody) return;

    const rows = summarizeSupplierDues(data);
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-5 text-sm text-slate-400 text-center">No supplier due amounts found.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item, index) => {
        const priority = getSupplierDuePriority(index, rows.length);
        return `
            <tr>
                <td class="px-4 py-3.5 text-sm"><span class="priority-chip priority-${priority.toLowerCase()}">${priority}</span></td>
                <td class="px-4 py-3.5 text-sm"><span class="vendor-chip">${item.vendorCode}</span></td>
                <td class="px-4 py-3.5 text-sm text-slate-700">${item.supplierName}</td>
                <td class="px-4 py-3.5 text-sm text-right font-bold text-rose-600">${formatMoney(item.dueAmount)}</td>
            </tr>`;
    }).join('');
}

function exportExcelReport() {
    if (!filtered.length) {
        alert('No data available to export yet.');
        return;
    }

    const detailedRows = filtered.map(row => ({
        'PO Date': getField(row, ['PO DATE']) || '',
        'PO No': getField(row, ['PO', 'PO NO.', 'PO NO']) || '',
        'Vendor Code': getField(row, ['VENDOR CODE']) || '',
        'Supplier Name': getField(row, ['SUPPLIER NAME']) || '',
        'RM Code': getField(row, ['RM CODE']) || '',
        'Category': categorizeRMCode(getField(row, ['RM CODE']) || ''),
        'Raw Material': getField(row, ['RM NAME']) || '',
        'Qty Ordered': parseNumber(getField(row, ['QTY ORDERED']) || 0),
        'Qty Received': parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0),
        'Qty Balance': parseNumber(getField(row, ['QTY BALANCE']) || 0),
        'Order Value SAR': parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0),
        'Received Value SAR': parseSAR(getField(row, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0)
    }));

    const materialSummary = summarizeMaterials(filtered)
        .sort((a, b) => b.ordered - a.ordered)
        .map(item => ({
            'RM Code': item.rmCode,
            'Category': item.category,
            'Raw Material': item.name,
            'Total Ordered Qty': item.ordered,
            'Total Received Qty': item.received,
            'Balance Qty': item.ordered - item.received,
            'Order Value SAR': item.value
        }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(materialSummary), 'Material Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailedRows), 'PO Register');

    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `RM_Register_Report_${dateStamp}.xlsx`);
}

function exportPendingRMReport() {
    const pendingRows = filtered
        .map(row => {
            const qtyOrdered = parseNumber(getField(row, ['QTY ORDERED']) || 0);
            const qtyReceived = parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0);
            const qtyBalanceRaw = getField(row, ['QTY BALANCE']);
            const qtyBalance = parseNumber(qtyBalanceRaw || (qtyOrdered - qtyReceived));

            return {
                'PO Date': getField(row, ['PO DATE']) || '',
                'PO No': getField(row, ['PO', 'PO NO.', 'PO NO']) || '',
                'Vendor Code': getField(row, ['VENDOR CODE']) || '',
                'Supplier Name': getField(row, ['SUPPLIER NAME']) || '',
                'RM Code': getField(row, ['RM CODE']) || '',
                'Category': categorizeRMCode(getField(row, ['RM CODE']) || ''),
                'Raw Material': getField(row, ['RM NAME']) || '',
                'Qty Ordered': qtyOrdered,
                'Qty Received': qtyReceived,
                'Pending Qty': qtyBalance,
                'Order Value SAR': parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0),
                'Received Value SAR': parseSAR(getField(row, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0),
                'Status': qtyBalance > 0 ? 'Pending' : 'Completed'
            };
        })
        .filter(row => row['Pending Qty'] > 0)
        .sort((a, b) => b['Pending Qty'] - a['Pending Qty']);

    if (!pendingRows.length) {
        alert('No pending raw materials found for export.');
        return;
    }

    const pendingSummary = pendingRows.reduce((acc, row) => {
        const key = `${row['RM Code']}__${row['Raw Material']}`;
        if (!acc[key]) {
            acc[key] = {
                'RM Code': row['RM Code'],
                'Category': row['Category'],
                'Raw Material': row['Raw Material'],
                'Total Pending Qty': 0,
                'Total Ordered Qty': 0,
                'Total Received Qty': 0,
                'Open POs': 0
            };
        }

        acc[key]['Total Pending Qty'] += row['Pending Qty'];
        acc[key]['Total Ordered Qty'] += row['Qty Ordered'];
        acc[key]['Total Received Qty'] += row['Qty Received'];
        acc[key]['Open POs'] += 1;
        return acc;
    }, {});

    const summaryRows = Object.values(pendingSummary).sort((a, b) => b['Total Pending Qty'] - a['Total Pending Qty']);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Pending Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pendingRows), 'Pending PO Details');

    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Pending_RM_Report_${dateStamp}.xlsx`);
}

function showError(msg) {
    const el = document.getElementById('loading');
    el.innerHTML = `<div class="inline-flex items-center gap-3 p-5 bg-orange-50 text-orange-700 border border-orange-200 rounded-xl text-sm max-w-lg">
        <i class="fas fa-exclamation-triangle text-lg"></i>
        <div><p class="font-semibold">Failed to load data</p><p class="text-orange-600 mt-1">${msg}</p></div>
    </div>`;
}