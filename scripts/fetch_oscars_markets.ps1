param(
    [int]$Year = 2026,
    [string]$OutputDir = "data",
    [string]$SiteDir = "site"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$limit = 200
$sourceUrl = "https://gamma-api.polymarket.com/events?tag_slug=oscars&limit=$limit"
$yearPrefix = "oscars-$Year-"
$winnerSlugPattern = "^$yearPrefix.*-winner(?:-\d+)?$"

function Convert-JsonArrayString {
    param(
        [AllowNull()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return @()
    }

    return @($Value | ConvertFrom-Json)
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$rawDir = Join-Path $OutputDir "raw"
$summaryDir = Join-Path $OutputDir "summary"
$siteDataDir = Join-Path $SiteDir "data"

foreach ($dir in @($rawDir, $summaryDir, $siteDataDir)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

$eventsResponse = & curl.exe -s --fail $sourceUrl

if ($LASTEXITCODE -ne 0) {
    throw "Failed to fetch Polymarket data from $sourceUrl"
}

$events = $eventsResponse | ConvertFrom-Json

$winnerEvents = @(
    $events |
    Where-Object { $_.slug -match $winnerSlugPattern } |
    Sort-Object title
)

$fetchedAt = (Get-Date).ToString("o")
$safeYear = "$Year"

$rawOutputPath = Join-Path $rawDir "oscars_${safeYear}_winner_events.json"
$nomineeRawOutputPath = Join-Path $rawDir "oscars_${safeYear}_nominee_markets.json"
$summaryOutputPath = Join-Path $summaryDir "oscars_${safeYear}_winner_events.csv"
$slugOutputPath = Join-Path $summaryDir "oscars_${safeYear}_winner_urls.txt"
$nomineeSummaryOutputPath = Join-Path $summaryDir "oscars_${safeYear}_nominee_prices.csv"
$siteDashboardOutputPath = Join-Path $siteDataDir "oscars_${safeYear}_dashboard.json"

$summaryRows = foreach ($event in $winnerEvents) {
    $category = ($event.title.Trim() -replace "^Oscars ${Year}:\s*", "" -replace "\s*Winner\s*$", "").Trim()

    [PSCustomObject]@{
        year = $Year
        title = $event.title.Trim()
        category = $category
        slug = $event.slug
        url = "https://polymarket.com/event/$($event.slug)"
        eventId = $event.id
        marketCount = @($event.markets).Count
        liquidity = $event.liquidity
        volume = $event.volume
        volume24hr = $event.volume24hr
        commentCount = $event.commentCount
        startDate = $event.startDate
        endDate = $event.endDate
        createdAt = $event.createdAt
        updatedAt = $event.updatedAt
        active = $event.active
        closed = $event.closed
    }
}

$nomineeRows = @(
    foreach ($event in $winnerEvents) {
        $eventTitle = $event.title.Trim()
        $category = ($eventTitle -replace "^Oscars ${Year}:\s*", "" -replace "\s*Winner\s*$", "").Trim()
        $eventUrl = "https://polymarket.com/event/$($event.slug)"

        foreach ($market in @($event.markets | Where-Object { $_.active -eq $true -and $_.closed -eq $false })) {
            $outcomes = Convert-JsonArrayString -Value $market.outcomes
            $outcomePrices = Convert-JsonArrayString -Value $market.outcomePrices

            [PSCustomObject]@{
                year = $Year
                eventTitle = $eventTitle
                category = $category
                eventId = $event.id
                eventSlug = $event.slug
                eventUrl = $eventUrl
                nominee = $market.groupItemTitle.Trim()
                marketId = $market.id
                marketSlug = $market.slug
                question = $market.question
                yesLabel = if ($outcomes.Count -gt 0) { $outcomes[0] } else { $null }
                noLabel = if ($outcomes.Count -gt 1) { $outcomes[1] } else { $null }
                yesPrice = if ($outcomePrices.Count -gt 0) { [decimal]$outcomePrices[0] } else { $null }
                noPrice = if ($outcomePrices.Count -gt 1) { [decimal]$outcomePrices[1] } else { $null }
                lastTradePrice = $market.lastTradePrice
                bestBid = $market.bestBid
                bestAsk = $market.bestAsk
                spread = $market.spread
                volume = $market.volumeNum
                volume24hr = $market.volume24hr
                liquidity = $market.liquidityNum
                updatedAt = $market.updatedAt
                active = $market.active
                closed = $market.closed
            }
        }
    }
)

$nomineeRows = @(
    $nomineeRows |
    Sort-Object category, @{ Expression = { $_.yesPrice }; Descending = $true }, nominee
)

$categoryRows = @(
    $nomineeRows |
    Group-Object category |
    Sort-Object Name |
    ForEach-Object {
        $categoryNominees = @(
            $_.Group |
            Sort-Object @{ Expression = { $_.yesPrice }; Descending = $true }, nominee
        )

        $leader = $categoryNominees | Select-Object -First 1

        [PSCustomObject]@{
            category = $_.Name
            eventTitle = $leader.eventTitle
            eventId = $leader.eventId
            eventSlug = $leader.eventSlug
            eventUrl = $leader.eventUrl
            nomineeCount = $categoryNominees.Count
            totalVolume24hr = ($categoryNominees | Measure-Object -Property volume24hr -Sum).Sum
            totalVolume = ($categoryNominees | Measure-Object -Property volume -Sum).Sum
            leader = $leader
            nominees = $categoryNominees
        }
    }
)

$rawPayload = [PSCustomObject]@{
    fetchedAt = $fetchedAt
    sourceUrl = $sourceUrl
    year = $Year
    eventCount = $winnerEvents.Count
    events = $winnerEvents
}

$nomineePayload = [PSCustomObject]@{
    fetchedAt = $fetchedAt
    sourceUrl = $sourceUrl
    year = $Year
    rowCount = $nomineeRows.Count
    nominees = $nomineeRows
}

$dashboardPayload = [PSCustomObject]@{
    fetchedAt = $fetchedAt
    sourceUrl = $sourceUrl
    year = $Year
    summary = [PSCustomObject]@{
        categoryCount = $categoryRows.Count
        nomineeCount = $nomineeRows.Count
        totalVolume24hr = ($nomineeRows | Measure-Object -Property volume24hr -Sum).Sum
        totalVolume = ($nomineeRows | Measure-Object -Property volume -Sum).Sum
        frontrunners = @(
            $categoryRows |
            ForEach-Object { $_.leader } |
            Sort-Object @{ Expression = { $_.yesPrice }; Descending = $true }, category
        )
    }
    categories = $categoryRows
}

$rawPayload |
    ConvertTo-Json -Depth 100 |
    Set-Content -Path $rawOutputPath -Encoding UTF8

$nomineePayload |
    ConvertTo-Json -Depth 100 |
    Set-Content -Path $nomineeRawOutputPath -Encoding UTF8

$dashboardPayload |
    ConvertTo-Json -Depth 100 |
    Set-Content -Path $siteDashboardOutputPath -Encoding UTF8

$summaryRows |
    Export-Csv -Path $summaryOutputPath -NoTypeInformation -Encoding UTF8

$nomineeRows |
    Export-Csv -Path $nomineeSummaryOutputPath -NoTypeInformation -Encoding UTF8

$summaryRows.url |
    Set-Content -Path $slugOutputPath -Encoding UTF8

Write-Host "Fetched $($winnerEvents.Count) Oscars $Year winner events."
Write-Host "Open nominee markets: $($nomineeRows.Count)"
Write-Host "Raw JSON: $rawOutputPath"
Write-Host "Nominee JSON: $nomineeRawOutputPath"
Write-Host "Summary CSV: $summaryOutputPath"
Write-Host "Nominee CSV: $nomineeSummaryOutputPath"
Write-Host "Dashboard JSON: $siteDashboardOutputPath"
Write-Host "URLs: $slugOutputPath"

if ($winnerEvents.Count -ne 24) {
    Write-Warning "Expected 24 winner events for Oscars $Year, but found $($winnerEvents.Count)."
}

if ($nomineeRows.Count -ne 125) {
    Write-Warning "Expected 125 open nominee markets for Oscars $Year, but found $($nomineeRows.Count)."
}
