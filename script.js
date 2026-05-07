const CSV_URL     = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKJrZEW_VHDU987NKqyi3dcc5gspCCXjnnyL0INxJ-16DP1-pUTaBeXttRn9Ys6w/pub?output=csv';
const GRN_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKJrZEW_VHDU987NKqyi3dcc5gspCCXjnnyL0INxJ-16DP1-pUTaBeXttRn9Ys6w/pub?output=csv&gid=1571662947';

let rawData  = [];
let grnData  = [];
let filtered = [];
let manualSupplierDueEntries = [];
let duePaymentStatusMap = {};
let supplierDueFilter = 'all';
let dashboardMetricMode = 'value';
let dashboardPresentationMode = false;

const MANUAL_DUE_STORAGE_KEY = 'rm_manual_supplier_due_entries_v1';
const DUE_PAYMENT_STATUS_STORAGE_KEY = 'rm_due_payment_status_v1';

document.addEventListener('DOMContentLoaded', () => {
    loadDueTrackingState();
    fetchData();
    document.getElementById('searchInput').addEventListener('input', (e) => applyFilters());
    const manualDueForm = document.getElementById('manualDueForm');
    if (manualDueForm) {
        manualDueForm.addEventListener('submit', handleManualDueSubmit);
    }
    initializeDueFilters();
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && dashboardPresentationMode) {
            setDashboardPresentationMode(false, false);
        }
    });
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
    const vendors = new Set(data.map(r => getField(r, ['VENDOR CODE', 'V CODE'])).filter(Boolean)).size;

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
        const date = getField(row, ['PO DATE', 'PO DATE.']) || '-';
        const po = getField(row, ['PO', 'PO NO.', 'PO NO']) || '-';
        const vendor = getField(row, ['VENDOR CODE', 'V CODE']) || '-';
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
        const rowDate = parseDate(getField(row, ['PO DATE', 'PO DATE.']));
        const matchFrom = !fromDate || !rowDate || rowDate >= fromDate;
        const matchTo   = !toDate || !rowDate || rowDate <= toDate;
        return matchSearch && matchFrom && matchTo;
    });

    renderTable(filtered);
    updateStats(filtered);
    renderInsights(filtered);
    renderSupplierDueList(filtered);
    renderManagementDashboard(filtered);
}

function applyDateFilter() { applyFilters(); }

function clearDateFilter() {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value   = '';
    applyFilters();
}

function closeReportsMenu() {
    const menu = document.getElementById('reportsMenu');
    if (menu) menu.removeAttribute('open');
}

function setDashboardMetricMode(mode) {
    dashboardMetricMode = mode === 'qty' ? 'qty' : 'value';
    const byValue = document.getElementById('dashboardModeValue');
    const byQty = document.getElementById('dashboardModeQty');
    if (byValue) byValue.classList.toggle('active', dashboardMetricMode === 'value');
    if (byQty) byQty.classList.toggle('active', dashboardMetricMode === 'qty');
    renderManagementDashboard(filtered);
}

function updateDashboardPresentationButton() {
    const btn = document.getElementById('dashboardPresentationBtn');
    if (!btn) return;

    if (dashboardPresentationMode) {
        btn.innerHTML = '<i class="fas fa-compress"></i> Exit Presentation';
    } else {
        btn.innerHTML = '<i class="fas fa-expand"></i> Presentation Mode';
    }
}

function setDashboardPresentationMode(enabled, scrollIntoView) {
    dashboardPresentationMode = enabled;
    document.body.classList.toggle('dashboard-presentation-mode', enabled);

    const dashboardSection = document.getElementById('managementDashboardSection');
    const children = document.querySelectorAll('main > *');
    children.forEach(el => {
        if (el !== dashboardSection) {
            el.classList.toggle('dashboard-hidden-for-present', enabled);
        }
    });

    if (dashboardSection) {
        dashboardSection.classList.remove('hidden');
        if (enabled && scrollIntoView) {
            dashboardSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    updateDashboardPresentationButton();
}

async function toggleDashboardPresentationMode() {
    const dashboardSection = document.getElementById('managementDashboardSection');
    if (dashboardSection) {
        dashboardSection.classList.remove('hidden');
    }
    renderManagementDashboard(filtered);

    if (!dashboardPresentationMode) {
        setDashboardPresentationMode(true, true);
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            try {
                await document.documentElement.requestFullscreen();
            } catch (err) {
                // Keep presentation layout even if browser blocks fullscreen.
            }
        }
        return;
    }

    if (document.fullscreenElement && document.exitFullscreen) {
        try {
            await document.exitFullscreen();
        } catch (err) {
            setDashboardPresentationMode(false, false);
        }
    } else {
        setDashboardPresentationMode(false, false);
    }
}

function generateManagementDashboard() {
    const section = document.getElementById('managementDashboardSection');
    if (!section) return;
    section.classList.remove('hidden');
    renderManagementDashboard(filtered);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initializeDueFilters() {
    const buttons = document.querySelectorAll('.due-filter-btn[data-due-filter]');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            supplierDueFilter = btn.dataset.dueFilter || 'all';
            updateDueFilterButtons();
            renderSupplierDueList(filtered);
        });
    });
    updateDueFilterButtons();
}

function updateDueFilterButtons() {
    const buttons = document.querySelectorAll('.due-filter-btn[data-due-filter]');
    buttons.forEach(btn => {
        const isActive = (btn.dataset.dueFilter || 'all') === supplierDueFilter;
        btn.classList.toggle('active', isActive);
    });
}

function loadDueTrackingState() {
    try {
        const manualRaw = localStorage.getItem(MANUAL_DUE_STORAGE_KEY);
        manualSupplierDueEntries = manualRaw ? JSON.parse(manualRaw) : [];
    } catch (err) {
        manualSupplierDueEntries = [];
    }

    try {
        const statusRaw = localStorage.getItem(DUE_PAYMENT_STATUS_STORAGE_KEY);
        duePaymentStatusMap = statusRaw ? JSON.parse(statusRaw) : {};
    } catch (err) {
        duePaymentStatusMap = {};
    }
}

function saveManualDueEntries() {
    localStorage.setItem(MANUAL_DUE_STORAGE_KEY, JSON.stringify(manualSupplierDueEntries));
}

function saveDuePaymentStatus() {
    localStorage.setItem(DUE_PAYMENT_STATUS_STORAGE_KEY, JSON.stringify(duePaymentStatusMap));
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

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    return String(key || '')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
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
            cards.push({ no: 'Summary', dt: getField(row, ['PO Date', 'PO DATE', 'PO DATE.']) || '', qty: qtyRecd });
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

function summarizeVendors(data) {
    const summary = new Map();

    data.forEach(row => {
        const vendorCode = String(getField(row, ['VENDOR CODE', 'V CODE']) || '').trim() || 'Others';
        const supplierName = String(getField(row, ['SUPPLIER NAME']) || '').trim() || 'Others';
        const key = `${vendorCode}__${supplierName}`;
        if (!summary.has(key)) {
            summary.set(key, { vendorCode, supplierName, orderValue: 0, orderedQty: 0, poCount: 0 });
        }

        const item = summary.get(key);
        item.orderValue += parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
        item.orderedQty += parseNumber(getField(row, ['QTY ORDERED']) || 0);
        item.poCount += 1;
    });

    return Array.from(summary.values());
}

function summarizeCategoryMix(data) {
    const summary = new Map();

    data.forEach(row => {
        const category = categorizeRMCode(getField(row, ['RM CODE']) || '');
        const orderedQty = parseNumber(getField(row, ['QTY ORDERED']) || 0);
        const orderValue = parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
        if (!summary.has(category)) {
            summary.set(category, { category, orderedQty: 0, orderValue: 0 });
        }

        const item = summary.get(category);
        item.orderedQty += orderedQty;
        item.orderValue += orderValue;
    });

    return Array.from(summary.values());
}

function renderDashboardRankList(containerId, rows, getLabel, getValue, formatValue) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!rows.length) {
        container.innerHTML = '<div class="text-sm text-slate-400">No data available.</div>';
        return;
    }

    const topRows = rows.slice(0, 6);
    const maxValue = Math.max(...topRows.map(getValue), 1);

    container.innerHTML = topRows.map((row, idx) => {
        const value = getValue(row);
        const pct = Math.max(4, Math.round((value / maxValue) * 100));
        return `
            <div class="dashboard-row">
                <div class="dashboard-row-head">
                    <span class="dashboard-rank">${idx + 1}</span>
                    <span class="dashboard-label">${escapeHtml(getLabel(row))}</span>
                    <span class="dashboard-value">${formatValue(value)}</span>
                </div>
                <div class="dashboard-bar"><span style="width:${pct}%"></span></div>
            </div>`;
    }).join('');
}

function renderManagementDashboard(data) {
    const section = document.getElementById('managementDashboardSection');
    if (!section || section.classList.contains('hidden')) return;

    const orderValue = data.reduce((s, r) => s + parseSAR(getField(r, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0), 0);
    const receivedValue = data.reduce((s, r) => s + parseSAR(getField(r, ['TOTAL RECEIVED RM PRICE IN RIYAL', 'TOTAL RECEIVED VALUE']) || 0), 0);
    const pendingValue = Math.max(orderValue - receivedValue, 0);
    const dueRows = summarizeSupplierDues(data);
    const unpaidDueRows = dueRows.filter(r => !getPaymentState(r.id).paid);
    const unpaidDueValue = unpaidDueRows.reduce((sum, row) => sum + row.dueAmount, 0);
    const overdueCount = unpaidDueRows.filter(r => getSupplierDuePriority(r.dueDate) === 'High').length;

    const cards = [
        { title: 'Records', value: data.length.toLocaleString(), tone: 'blue' },
        { title: 'Order Value', value: 'SAR ' + formatMoney(orderValue), tone: 'indigo' },
        { title: 'Received Value', value: 'SAR ' + formatMoney(receivedValue), tone: 'emerald' },
        { title: 'Pending Value', value: 'SAR ' + formatMoney(pendingValue), tone: 'amber' },
        { title: 'Unpaid Due', value: 'SAR ' + formatMoney(unpaidDueValue), note: overdueCount + ' overdue', tone: 'rose' }
    ];

    const kpiEl = document.getElementById('dashboardKpiCards');
    if (kpiEl) {
        kpiEl.innerHTML = cards.map(card => `
            <div class="dashboard-kpi tone-${card.tone}">
                <div class="kpi-title">${card.title}</div>
                <div class="kpi-value">${card.value}</div>
                <div class="kpi-note">${card.note || ''}</div>
            </div>
        `).join('');
    }

    const vendors = summarizeVendors(data).sort((a, b) => {
        return dashboardMetricMode === 'qty' ? (b.orderedQty - a.orderedQty) : (b.orderValue - a.orderValue);
    });

    renderDashboardRankList(
        'dashboardTopVendors',
        vendors,
        row => `${row.vendorCode} • ${row.supplierName}`,
        row => dashboardMetricMode === 'qty' ? row.orderedQty : row.orderValue,
        value => dashboardMetricMode === 'qty' ? formatQty(value) : ('SAR ' + formatMoney(value))
    );

    const categories = summarizeCategoryMix(data).sort((a, b) => {
        return dashboardMetricMode === 'qty' ? (b.orderedQty - a.orderedQty) : (b.orderValue - a.orderValue);
    });

    renderDashboardRankList(
        'dashboardCategoryMix',
        categories,
        row => row.category,
        row => dashboardMetricMode === 'qty' ? row.orderedQty : row.orderValue,
        value => dashboardMetricMode === 'qty' ? formatQty(value) : ('SAR ' + formatMoney(value))
    );

    const { summaryRows, pendingRows } = buildPendingReportData(data);
    const pendingEl = document.getElementById('dashboardPendingSummary');
    if (pendingEl) {
        const totalPendingQty = pendingRows.reduce((sum, r) => sum + (r['Pending Qty'] || 0), 0);
        pendingEl.innerHTML = `
            <div class="dashboard-mini-card"><span>Open POs</span><strong>${pendingRows.length.toLocaleString()}</strong></div>
            <div class="dashboard-mini-card"><span>Pending Qty</span><strong>${formatQty(totalPendingQty)}</strong></div>
            <div class="dashboard-mini-card"><span>RM Lines</span><strong>${summaryRows.length.toLocaleString()}</strong></div>`;
    }

    const dueEl = document.getElementById('dashboardDueSummary');
    if (dueEl) {
        const paidRows = dueRows.length - unpaidDueRows.length;
        dueEl.innerHTML = `
            <div class="dashboard-mini-card"><span>Due Lines</span><strong>${dueRows.length.toLocaleString()}</strong></div>
            <div class="dashboard-mini-card"><span>Unpaid Lines</span><strong>${unpaidDueRows.length.toLocaleString()}</strong></div>
            <div class="dashboard-mini-card"><span>Paid Lines</span><strong>${paidRows.toLocaleString()}</strong></div>`;
    }
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

function parsePaymentTermDays(value) {
    const match = String(value || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function addDays(date, days) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function formatDisplayDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '-';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

function getSupplierDuePriority(dueDate) {
    if (!(dueDate instanceof Date) || Number.isNaN(dueDate.getTime())) return 'Low';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffDays = Math.floor((dueDate.getTime() - today.getTime()) / 86400000);
    if (diffDays <= 0) return 'High';
    if (diffDays <= 14) return 'Medium';
    return 'Low';
}

function getDueEntryId(entry, source) {
    if (source === 'Manual') return entry.id;
    const dateKey = formatDisplayDate(entry.dueDate);
    return `AUTO|${entry.vendorCode}|${entry.supplierName}|${entry.paymentTerms}|${dateKey}`;
}

function getPaymentState(entryId) {
    const state = duePaymentStatusMap[entryId];
    if (!state) return { paid: false, paidOn: '' };
    return { paid: Boolean(state.paid), paidOn: state.paidOn || '' };
}

function getManualSupplierDueRows() {
    return manualSupplierDueEntries
        .map(item => {
            const receivedDate = parseDate(item.receivedDate || '');
            const dueDate = parseDate(item.dueDate || '');
            const dueAmount = parseNumber(item.dueAmount || 0);
            if (!dueDate || dueAmount <= 0) return null;

            return {
                id: item.id,
                vendorCode: item.vendorCode || 'Others',
                supplierName: item.supplierName || 'Others',
                paymentTerms: item.paymentTerms || '0 DAYS',
                receivedDate: receivedDate || dueDate,
                dueDate,
                dueAmount,
                priority: getSupplierDuePriority(dueDate),
                source: 'Manual'
            };
        })
        .filter(Boolean);
}

function handleManualDueSubmit(event) {
    event.preventDefault();

    const supplierName = String(document.getElementById('manualSupplierName').value || '').trim();
    const dueAmount = parseNumber(document.getElementById('manualDueAmount').value || 0);
    const vendorCode = String(document.getElementById('manualVendorCode').value || '').trim() || 'Others';
    const paymentTerms = String(document.getElementById('manualPaymentTerms').value || '').trim() || '0 DAYS';
    const receivedDateRaw = document.getElementById('manualReceivedDate').value;
    const dueDateRaw = document.getElementById('manualDueDate').value;

    if (!supplierName) {
        alert('Supplier name is required for manual due entry.');
        return;
    }

    if (dueAmount <= 0) {
        alert('Due amount must be greater than zero.');
        return;
    }

    const receivedDate = parseInputDate(receivedDateRaw, false);
    if (!receivedDate) {
        alert('Please select a valid received date.');
        return;
    }

    let dueDate = parseInputDate(dueDateRaw, true);
    if (!dueDate) {
        dueDate = addDays(receivedDate, parsePaymentTermDays(paymentTerms));
    }

    const entry = {
        id: `MANUAL|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`,
        vendorCode,
        supplierName,
        paymentTerms,
        receivedDate: formatDisplayDate(receivedDate),
        dueDate: formatDisplayDate(dueDate),
        dueAmount,
        createdAt: new Date().toISOString()
    };

    manualSupplierDueEntries.push(entry);
    saveManualDueEntries();
    event.target.reset();
    document.getElementById('manualPaymentTerms').value = '0 DAYS';
    renderSupplierDueList(filtered);
}

function toggleDuePayment(entryId) {
    const current = getPaymentState(entryId);
    if (current.paid) {
        duePaymentStatusMap[entryId] = { paid: false, paidOn: '' };
    } else {
        duePaymentStatusMap[entryId] = {
            paid: true,
            paidOn: formatDisplayDate(new Date())
        };
    }

    saveDuePaymentStatus();
    renderSupplierDueList(filtered);
}

function getDueEntriesForRow(row) {
    const vendorCode = String(getField(row, ['VENDOR CODE', 'V CODE']) || '').trim() || 'Others';
    const supplierName = String(getField(row, ['SUPPLIER NAME']) || '').trim() || 'Others';
    const paymentTerms = String(getField(row, ['PAYMENT', 'PAYMENT TERMS']) || '').trim() || '0 DAYS';
    const paymentDays = parsePaymentTermDays(paymentTerms);
    const qtyOrdered = parseNumber(getField(row, ['QTY ORDERED']) || 0);
    const orderValue = parseSAR(getField(row, ['TOTAL ORDERED RM PRICE IN RIYAL', 'TOTAL ORDER VALUE']) || 0);
    const po = getField(row, ['PO', 'PO NO.', 'PO NO']) || '';
    const materialName = getField(row, ['RM NAME', 'Rm Name', 'Rm Name.']) || '';

    if (qtyOrdered <= 0 || orderValue <= 0) return [];

    const unitValue = orderValue / qtyOrdered;
    const grns = getMatchingGrns(po, materialName);
    const cards = dedupeGrnCards(grns.flatMap(extractGrnCards));

    return cards.map(card => {
        const receivedQty = parseNumber(card.qty || 0);
        const receivedDate = parseDate(card.dt || '');
        const dueDate = addDays(receivedDate, paymentDays);
        const dueAmount = receivedQty * unitValue;

        if (receivedQty <= 0 || !receivedDate || !dueDate || dueAmount <= 0) return null;

        return {
            vendorCode,
            supplierName,
            paymentTerms,
            receivedDate,
            dueDate,
            dueAmount,
            priority: getSupplierDuePriority(dueDate)
        };
    }).filter(Boolean);
}

function summarizeSupplierDues(data) {
    const summary = new Map();

    data.forEach(row => {
        getDueEntriesForRow(row).forEach(entry => {
            const dueKey = formatDisplayDate(entry.dueDate);
            const key = `${entry.vendorCode}__${entry.supplierName}__${entry.paymentTerms}__${dueKey}`;

            if (!summary.has(key)) {
                summary.set(key, {
                    vendorCode: entry.vendorCode,
                    supplierName: entry.supplierName,
                    paymentTerms: entry.paymentTerms,
                    receivedDate: entry.receivedDate,
                    dueDate: entry.dueDate,
                    dueAmount: 0,
                    priority: entry.priority,
                    source: 'Auto'
                });
            }

            const item = summary.get(key);
            item.dueAmount += entry.dueAmount;
            if (entry.receivedDate < item.receivedDate) item.receivedDate = entry.receivedDate;
            if (entry.dueDate < item.dueDate) item.dueDate = entry.dueDate;
            item.priority = getSupplierDuePriority(item.dueDate);
        });
    });

    const autoRows = Array.from(summary.values()).map(item => ({
        ...item,
        id: getDueEntryId(item, 'Auto')
    }));

    const manualRows = getManualSupplierDueRows();

    return [...autoRows, ...manualRows].sort((a, b) => {
        const aPaid = getPaymentState(a.id).paid;
        const bPaid = getPaymentState(b.id).paid;
        if (aPaid !== bPaid) return aPaid ? 1 : -1;

        const priorityOrder = { High: 0, Medium: 1, Low: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        const dateDiff = a.dueDate - b.dueDate;
        if (dateDiff !== 0) return dateDiff;
        return b.dueAmount - a.dueAmount;
    });
}

function filterSupplierDueRows(rows) {
    if (supplierDueFilter === 'all') return rows;

    return rows.filter(item => {
        const isPaid = getPaymentState(item.id).paid;
        if (supplierDueFilter === 'paid') return isPaid;
        if (supplierDueFilter === 'unpaid') return !isPaid;
        if (supplierDueFilter === 'manual') return item.source === 'Manual';
        return true;
    });
}

function renderSupplierDueList(data) {
    const tbody = document.getElementById('supplierDueListBody');
    if (!tbody) return;

    const rows = filterSupplierDueRows(summarizeSupplierDues(data));
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="px-4 py-5 text-sm text-slate-400 text-center">No supplier due amounts found.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((item) => {
        const paymentState = getPaymentState(item.id);
        const encodedId = encodeURIComponent(item.id);
        const paymentChip = paymentState.paid
            ? `<button class="payment-toggle paid" onclick="toggleDuePayment(decodeURIComponent('${encodedId}'))">Paid ${escapeHtml(paymentState.paidOn || '')}</button>`
            : `<button class="payment-toggle unpaid" onclick="toggleDuePayment(decodeURIComponent('${encodedId}'))">Mark Paid</button>`;

        return `
            <tr>
                <td class="px-4 py-3.5 text-sm"><span class="priority-chip priority-${item.priority.toLowerCase()}">${item.priority}</span></td>
                <td class="px-4 py-3.5 text-sm"><span class="vendor-chip">${escapeHtml(item.vendorCode)}</span></td>
                <td class="px-4 py-3.5 text-sm text-slate-700">${escapeHtml(item.supplierName)}</td>
                <td class="px-4 py-3.5 text-sm text-slate-600">${escapeHtml(item.paymentTerms)}</td>
                <td class="px-4 py-3.5 text-sm text-slate-600">${formatDisplayDate(item.receivedDate)}</td>
                <td class="px-4 py-3.5 text-sm font-semibold text-slate-700">${formatDisplayDate(item.dueDate)}</td>
                <td class="px-4 py-3.5 text-sm text-right font-bold text-rose-600">${formatMoney(item.dueAmount)}</td>
                <td class="px-4 py-3.5 text-sm">${paymentChip}</td>
                <td class="px-4 py-3.5 text-sm"><span class="source-chip ${item.source === 'Manual' ? 'source-manual' : 'source-auto'}">${item.source}</span></td>
            </tr>`;
    }).join('');
}

function getSupplierDueExportRows(data) {
    return summarizeSupplierDues(data).map(item => ({
        'Priority': item.priority,
        'Vendor Code': item.vendorCode,
        'Supplier Name': item.supplierName,
        'Payment Terms': item.paymentTerms,
        'Received Date': formatDisplayDate(item.receivedDate),
        'Due Date': formatDisplayDate(item.dueDate),
        'Due Amount SAR': Math.round(item.dueAmount),
        'Payment Made': getPaymentState(item.id).paid ? 'Yes' : 'No',
        'Paid On': getPaymentState(item.id).paidOn || '',
        'Source': item.source
    }));
}

function buildPendingReportData(data) {
    const pendingRows = data
        .map(row => {
            const qtyOrdered = parseNumber(getField(row, ['QTY ORDERED']) || 0);
            const qtyReceived = parseNumber(getField(row, ['QTY RECEIVED', 'QTY RECD']) || 0);
            const qtyBalanceRaw = getField(row, ['QTY BALANCE']);
            const qtyBalance = parseNumber(qtyBalanceRaw || (qtyOrdered - qtyReceived));

            return {
                'PO Date': getField(row, ['PO DATE', 'PO DATE.']) || '',
                'PO No': getField(row, ['PO', 'PO NO.', 'PO NO']) || '',
                'Vendor Code': getField(row, ['VENDOR CODE', 'V CODE']) || '',
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
    return { summaryRows, pendingRows };
}

function exportExcelReport() {
    if (!filtered.length) {
        alert('No data available to export yet.');
        return;
    }

    const detailedRows = filtered.map(row => ({
        'PO Date': getField(row, ['PO DATE', 'PO DATE.']) || '',
        'PO No': getField(row, ['PO', 'PO NO.', 'PO NO']) || '',
        'Vendor Code': getField(row, ['VENDOR CODE', 'V CODE']) || '',
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
    const { summaryRows, pendingRows } = buildPendingReportData(filtered);

    if (!pendingRows.length) {
        alert('No pending raw materials found for export.');
        return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Pending Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pendingRows), 'Pending PO Details');

    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Pending_RM_Report_${dateStamp}.xlsx`);
}

function exportSupplierDueReport() {
    const dueRows = getSupplierDueExportRows(filtered);
    if (!dueRows.length) {
        alert('No supplier due rows found to export.');
        return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dueRows), 'Supplier Due');

    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Supplier_Due_Report_${dateStamp}.xlsx`);
}

function exportAllReports() {
    if (!filtered.length) {
        alert('No data available to export yet.');
        return;
    }

    const detailedRows = filtered.map(row => ({
        'PO Date': getField(row, ['PO DATE', 'PO DATE.']) || '',
        'PO No': getField(row, ['PO', 'PO NO.', 'PO NO']) || '',
        'Vendor Code': getField(row, ['VENDOR CODE', 'V CODE']) || '',
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

    const { summaryRows, pendingRows } = buildPendingReportData(filtered);
    const dueRows = getSupplierDueExportRows(filtered);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(materialSummary), 'Material Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailedRows), 'PO Register');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Pending Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pendingRows), 'Pending PO Details');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dueRows), 'Supplier Due');

    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `All_RM_Reports_${dateStamp}.xlsx`);
}

function showError(msg) {
    const el = document.getElementById('loading');
    el.innerHTML = `<div class="inline-flex items-center gap-3 p-5 bg-orange-50 text-orange-700 border border-orange-200 rounded-xl text-sm max-w-lg">
        <i class="fas fa-exclamation-triangle text-lg"></i>
        <div><p class="font-semibold">Failed to load data</p><p class="text-orange-600 mt-1">${msg}</p></div>
    </div>`;
}