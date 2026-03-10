const DATA_URL = "data/oscars_2026_dashboard.json";

const state = {
    payload: null,
    search: "",
    sort: "confidence"
};

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
});

const preciseCurrencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
});

document.addEventListener("DOMContentLoaded", () => {
    void init();
});

async function init() {
    try {
        const response = await fetch(DATA_URL, { cache: "no-store" });

        if (!response.ok) {
            throw new Error(`Request failed with ${response.status}`);
        }

        state.payload = await response.json();
        bindControls();
        render();
    } catch (error) {
        renderError(error);
    }
}

function bindControls() {
    const searchInput = document.querySelector("#category-search");
    const sortSelect = document.querySelector("#category-sort");

    searchInput.addEventListener("input", (event) => {
        state.search = event.target.value.trim().toLowerCase();
        render();
    });

    sortSelect.addEventListener("change", (event) => {
        state.sort = event.target.value;
        render();
    });
}

function render() {
    const payload = state.payload;
    const filteredCategories = getFilteredCategories(payload.categories);

    renderSummary(payload);
    renderFrontRunnerStrip(payload.summary.frontrunners);
    renderCategoryPills(filteredCategories);
    renderResultsSummary(filteredCategories.length, payload.summary.categoryCount);
    renderCategories(filteredCategories);
}

function getFilteredCategories(categories) {
    const filtered = categories.filter((category) => {
        if (!state.search) {
            return true;
        }

        const haystack = [
            category.category,
            ...category.nominees.map((nominee) => nominee.nominee)
        ].join(" ").toLowerCase();

        return haystack.includes(state.search);
    });

    return filtered.sort((left, right) => compareCategories(left, right, state.sort));
}

function compareCategories(left, right, sortMode) {
    const leftLeader = left.leader.yesPrice;
    const rightLeader = right.leader.yesPrice;
    const leftGap = getLeaderGap(left);
    const rightGap = getLeaderGap(right);

    if (sortMode === "volume") {
        return right.totalVolume24hr - left.totalVolume24hr;
    }

    if (sortMode === "tightest") {
        return leftGap - rightGap;
    }

    if (sortMode === "alphabetical") {
        return left.category.localeCompare(right.category);
    }

    return rightLeader - leftLeader;
}

function renderSummary(payload) {
    const topLeader = payload.summary.frontrunners[0];

    document.querySelector("#metric-categories").textContent = String(payload.summary.categoryCount);
    document.querySelector("#metric-nominees").textContent = String(payload.summary.nomineeCount);
    document.querySelector("#metric-volume").textContent = formatCurrency(payload.summary.totalVolume24hr);
    document.querySelector("#metric-leader").textContent = `${topLeader.nominee} in ${topLeader.category} (${formatPercent(topLeader.yesPrice)})`;
    document.querySelector("#hero-updated").textContent = formatDateTime(payload.fetchedAt);
}

function renderFrontRunnerStrip(frontrunners) {
    const container = document.querySelector("#front-runner-strip");

    container.innerHTML = frontrunners
        .map((leader) => {
            const targetId = createAnchorId(leader.category);

            return `
                <a class="runner-chip" href="#${targetId}">
                    <span class="runner-chip-category">${escapeHtml(leader.category)}</span>
                    <span class="runner-chip-name">${escapeHtml(leader.nominee)}</span>
                    <span class="runner-chip-price">${formatPercent(leader.yesPrice)}</span>
                </a>
            `;
        })
        .join("");
}

function renderCategoryPills(categories) {
    const container = document.querySelector("#category-pills");

    container.innerHTML = categories
        .map((category) => `
            <a class="pill-link" href="#${createAnchorId(category.category)}">
                <span>${escapeHtml(category.category)}</span>
                <span class="pill-count">${category.nomineeCount}</span>
            </a>
        `)
        .join("");
}

function renderResultsSummary(filteredCount, totalCount) {
    const summary = document.querySelector("#results-summary");

    if (filteredCount === totalCount) {
        summary.textContent = `Showing all ${totalCount} categories.`;
        return;
    }

    summary.textContent = `Showing ${filteredCount} of ${totalCount} categories.`;
}

function renderCategories(categories) {
    const grid = document.querySelector("#category-grid");

    if (!categories.length) {
        grid.innerHTML = document.querySelector("#empty-state-template").innerHTML;
        return;
    }

    grid.innerHTML = categories
        .map((category, index) => renderCategoryCard(category, index))
        .join("");
}

function renderCategoryCard(category, index) {
    const leaderGap = getLeaderGap(category);
    const raceClass = getConfidenceClass(category.leader.yesPrice);
    const raceLabel = getConfidenceLabel(category.leader.yesPrice);

    return `
        <article class="category-card" id="${createAnchorId(category.category)}" style="--card-index: ${index};">
            <header class="category-header">
                <div>
                    <p class="section-kicker">Oscar category</p>
                    <h3 class="category-title">${escapeHtml(category.category)}</h3>
                </div>
                <a class="category-link" href="${escapeHtml(category.eventUrl)}" target="_blank" rel="noreferrer">Open market</a>
            </header>

            <div class="category-summary">
                <div class="leader-block">
                    <span class="leader-label">Front-runner</span>
                    <span class="leader-name">${escapeHtml(category.leader.nominee)}</span>
                    <span class="leader-price">${formatPercent(category.leader.yesPrice)}</span>
                    <p class="leader-gap">Lead over #2: ${formatPercent(leaderGap)}</p>
                    <span class="confidence-pill ${raceClass}">${raceLabel}</span>
                </div>

                <div class="detail-grid">
                    <div class="detail-card">
                        <span class="detail-label">Nominees</span>
                        <strong class="detail-value">${category.nomineeCount}</strong>
                    </div>
                    <div class="detail-card">
                        <span class="detail-label">24h volume</span>
                        <strong class="detail-value">${formatCurrency(category.totalVolume24hr)}</strong>
                    </div>
                    <div class="detail-card">
                        <span class="detail-label">Total volume</span>
                        <strong class="detail-value">${formatCurrency(category.totalVolume)}</strong>
                    </div>
                    <div class="detail-card">
                        <span class="detail-label">Top ask</span>
                        <strong class="detail-value">${formatPercent(category.leader.bestAsk)}</strong>
                    </div>
                </div>
            </div>

            <ol class="nominee-list">
                ${category.nominees.map((nominee, nomineeIndex) => renderNomineeRow(nominee, nomineeIndex)).join("")}
            </ol>
        </article>
    `;
}

function renderNomineeRow(nominee, nomineeIndex) {
    const barWidth = Math.max(2, nominee.yesPrice * 100);

    return `
        <li class="nominee-row ${nomineeIndex === 0 ? "is-leader" : ""}">
            <div class="row-rank">#${nomineeIndex + 1}</div>
            <div class="row-content">
                <div class="row-topline">
                    <span class="row-name">${escapeHtml(nominee.nominee)}</span>
                    <span class="row-price">${formatPercent(nominee.yesPrice)}</span>
                </div>
                <div class="bar-track">
                    <div class="bar-fill" style="width: ${barWidth}%;"></div>
                </div>
                <div class="row-meta">
                    <span>Bid ${formatPercent(nominee.bestBid)}</span>
                    <span>Ask ${formatPercent(nominee.bestAsk)}</span>
                    <span>24h ${formatCurrency(nominee.volume24hr)}</span>
                </div>
            </div>
        </li>
    `;
}

function renderError(error) {
    document.querySelector("#hero-updated").textContent = "Unable to load data";
    document.querySelector("#metric-leader").textContent = "Dashboard data unavailable";
    document.querySelector("#front-runner-strip").innerHTML = "";
    document.querySelector("#category-pills").innerHTML = "";
    document.querySelector("#results-summary").textContent = error.message;
    document.querySelector("#category-grid").innerHTML = `
        <article class="empty-state">
            <h3>Dashboard data failed to load.</h3>
            <p>${escapeHtml(error.message)}</p>
        </article>
    `;
}

function getLeaderGap(category) {
    if (category.nominees.length < 2) {
        return category.leader.yesPrice;
    }

    return category.nominees[0].yesPrice - category.nominees[1].yesPrice;
}

function getConfidenceClass(value) {
    if (value >= 0.75) {
        return "runaway";
    }

    if (value >= 0.55) {
        return "leaning";
    }

    return "live";
}

function getConfidenceLabel(value) {
    if (value >= 0.75) {
        return "Runaway favorite";
    }

    if (value >= 0.55) {
        return "Clear leader";
    }

    return "Live race";
}

function formatPercent(value) {
    if (!Number.isFinite(value)) {
        return "N/A";
    }

    const percentage = value * 100;
    const digits = percentage >= 10 ? 1 : percentage >= 1 ? 1 : 2;

    return `${percentage.toFixed(digits)}%`;
}

function formatCurrency(value) {
    if (!Number.isFinite(value)) {
        return "N/A";
    }

    if (Math.abs(value) >= 1000) {
        return compactCurrencyFormatter.format(value);
    }

    return preciseCurrencyFormatter.format(value);
}

function formatDateTime(value) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return "Unknown";
    }

    return parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

function createAnchorId(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
