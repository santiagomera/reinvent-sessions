const fs = require('fs');
const { program } = require('commander');

const COLUMNS = [
    ['Session ID', (s) => s.code],
    ['Title', (s) => s.title],
    ['Session Type', (s) => s.type],
    ['Favorite', (s) => (s.favorite ? 'Yes' : 'No')],
    ['Reserved', (s) => (s.reserved ? 'Yes' : 'No')],
    ['Walk-up Only', (s) => (s.walkUpOnly ? 'Yes' : 'No')],
    ['Level', (s) => s.level],
    ['Day', (s) => s.time.dayName],
    ['Date', (s) => s.time.date],
    ['Start Time', (s) => s.time.startTime],
    ['End Time', (s) => s.time.endTime],
    ['Duration (min)', (s) => s.time.length],
    ['Venue', (s) => s.venue],
    ['Room', (s) => s.room],
    ['Capacity', (s) => s.time.capacity],
    ['Seats Remaining', (s) => s.time.seatsRemaining],
    ['Topics', (s) => s.topics],
    ['Areas of Interest', (s) => s.areasOfInterest],
    ['Roles', (s) => s.roles],
    ['Features', (s) => s.features],
    ['Speakers', (s) => s.speakers],
    ['Abstract', (s) => s.abstract],
];

// Codes can contain whitespace that the agenda and the catalog don't agree on
const normalizeCode = (code) => String(code ?? '').replace(/\s+/g, '');

const attributeValues = (session, attributeId) => [
    ...new Set(
        (session?.attributevalues ?? [])
            .filter((a) => a.attribute_id === attributeId)
            .map((a) => a.value),
    ),
];

const csvField = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function toRow(session, catalogEntry, favorite, reserved) {
    const time = session.times?.[0] ?? {};
    const [venue, ...room] = (time.room ?? '').split(' | ');
    const list = (attributeId) => attributeValues(catalogEntry, attributeId).sort().join(', ');

    if (!catalogEntry) {
        console.warn(`Session "${session.code}" was not found in the session catalog.`);
    }

    return {
        code: session.code,
        title: session.title,
        type: catalogEntry?.type ?? '',
        favorite,
        reserved,
        walkUpOnly: attributeValues(catalogEntry, 'Walkuponlysession').length > 0,
        level: attributeValues(catalogEntry, 'Level').join(', '),
        time,
        venue,
        room: room.join(' | '),
        topics: list('Topic'),
        areasOfInterest: list('AreaofInterest'),
        roles: list('Role'),
        features: list('Features'),
        speakers: (session.participants ?? [])
            .map((p) => [p.fullName, p.jobTitle, p.companyName].filter(Boolean).join(' - '))
            .join('; '),
        abstract: session.abstract,
    };
}

function exportInterests(options) {
    const agenda = JSON.parse(fs.readFileSync(options.agenda, 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(options.catalog, 'utf8'));
    const catalogByCode = new Map(catalog.sessions.map((s) => [normalizeCode(s.code), s]));
    const interests = agenda.sessionInterests ?? [];
    // Personal calendar items in mySchedule have no session code
    const reserved = (agenda.mySchedule ?? []).filter((s) => normalizeCode(s.code).length > 0);
    const favoriteSessionIds = new Set(interests.map((s) => s.sessionID));
    const reservedSessionIds = new Set(reserved.map((s) => s.sessionID));

    // Reserved entries take precedence so the row shows the reserved time slot
    const sessionsById = new Map([...interests, ...reserved].map((s) => [s.sessionID, s]));

    const rows = [...sessionsById.values()]
        .map((session) => toRow(
            session,
            catalogByCode.get(normalizeCode(session.code)),
            favoriteSessionIds.has(session.sessionID),
            reservedSessionIds.has(session.sessionID),
        ))
        .sort((a, b) => `${a.time.date} ${a.time.startTime}`.localeCompare(`${b.time.date} ${b.time.startTime}`));

    const lines = [
        COLUMNS.map(([heading]) => csvField(heading)).join(','),
        ...rows.map((row) => COLUMNS.map(([, get]) => csvField(get(row))).join(',')),
    ];
    fs.writeFileSync(options.output, `${lines.join('\n')}\n`);
    console.log(`Wrote ${rows.length} sessions to ${options.output}`);
}

program
    .name('interests-to-csv')
    .description('Export the favorite and reserved sessions in agenda.json to CSV, enriched from the session catalog')
    .showHelpAfterError(true)
    .option('-a, --agenda <file>', 'the saved agenda JSON', 'sessions/agenda.json')
    .option('-c, --catalog <file>', 'the cached session catalog JSON', 'catalog/sessions.json')
    .option('-o, --output <file>', 'the output CSV file', 'sessions/interests.csv')
    .action(exportInterests)
    .parse();
