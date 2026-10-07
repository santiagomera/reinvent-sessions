const axios = require('axios');
const fs = require("fs");
const ics = require("ics");
const { DateTime } = require("luxon");
const { program } = require("commander");
const pluralize = require("pluralize");

const configTemplate = {
    cookie: "",
    rfapiprofileid: "",
    rfauthtoken: ""
};

// Check if config.json exists; if not, copy from the template
const CONFIG_FILE = 'config.json';

if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configTemplate, null, 2));
}

// Show help information
const CONFIG_HELP = `
Please open developer tools in your browser and log in to view your re:Invent agenda.

https://registration.awsevents.com/flow/awsevents/reinvent24/myagenda/page/myagenda

Update the values in config.json (shown below) with the corresponding headers from
the https://catalog.awsevents.com/api/myData request.

${JSON.stringify(configTemplate, null, 2)}
`.trimStart();

const CATALOG_URL = 'https://catalog.awsevents.com/api/sessions';
const CATALOG_PAGE_SIZE = 50;
const CATALOG_WIDGET_ID = 'yloMDinvijFk6PtNtWambWamU6mPKiRf';
const CATALOG_FILE = 'sessions.json';
const CATALOG_SEARCH_URL = 'https://registration.awsevents.com/flow/awsevents/reinvent2026/event-catalog/page/eventCatalog';
const EVENT_TIMEZONE = 'America/Los_Angeles';

// Load the configuration file and show help if any required value is missing
function loadConfig() {
    const {cookie, rfapiprofileid, rfauthtoken} = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    if (!cookie || !rfapiprofileid || !rfauthtoken) {
        console.error(CONFIG_HELP);
        process.exit(1);
    }

    return {cookie, rfapiprofileid, rfauthtoken};
}

// Download every page of the session catalog
const fetchCatalog = async () => {
    const {cookie, rfapiprofileid, rfauthtoken} = loadConfig();
    const sessions = [];

    try {
        console.error("Downloading session catalog ...");
        let total = Infinity;
        for (let from = 0; from < total; from += CATALOG_PAGE_SIZE) {
            const response = await axios.post(
                CATALOG_URL,
                `type=session&browserTimezone=America%2FNew_York&catalogDisplay=list&from=${from}&size=${CATALOG_PAGE_SIZE}`,
                {
                    headers: {
                        'accept': '*/*',
                        'accept-language': 'en-US,en;q=0.9',
                        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'rfapiprofileid': rfapiprofileid,
                        'rfauthtoken': rfauthtoken,
                        'rfwidgetid': CATALOG_WIDGET_ID,
                        'cookie': cookie,
                        'origin': 'https://registration.awsevents.com',
                        'referer': 'https://registration.awsevents.com/',
                    }
                }
            );

            // The first page nests its items under sectionList; later pages return them at the top level
            const page = response.data;
            const items = page.items ?? page.sectionList?.[0]?.items ?? [];
            total = page.totalSearchItems ?? page.total ?? 0;
            sessions.push(...items);

            if (items.length === 0) {
                break;
            }
        }
        console.error(`Downloaded ${sessions.length} catalog sessions.`);
        return {fetchedAt: new Date().toISOString(), sessions};
    } catch (error) {
        if (error.response) {
            console.error(`Failed to fetch session catalog. HTTP Status: ${error.response.status}`);
        } else {
            console.error(`An error occurred: ${error.message}`);
        }
        process.exit(1);
    }
};

// Return the cached catalog if present, otherwise download it and cache it in catalogDir
const loadCatalog = async (catalogDir) => {
    const cacheFile = `${catalogDir}/${CATALOG_FILE}`;

    let catalog = null;
    if (fs.existsSync(cacheFile)) {
        try {
            catalog = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            console.error(`Using cached session catalog from ${cacheFile} (fetched ${catalog.fetchedAt}).`);
        } catch (error) {
            console.warn(`Ignoring unreadable session catalog ${cacheFile}: ${error.message}`);
            catalog = null;
        }
    }

    if (!Array.isArray(catalog?.sessions)) {
        catalog = await fetchCatalog();
        fs.writeFileSync(cacheFile, JSON.stringify(catalog));
        console.error(`Saved session catalog to ${cacheFile}`);
    }

    return indexCatalog(catalog.sessions);
};

// Function to fetch the agenda data
const fetchAgenda = async (options, catalog) => {
    const {cookie, rfapiprofileid, rfauthtoken} = loadConfig();

    try {
        console.error("Retrieving agenda ...");
        // Make the HTTP request using axios
        const response = await axios.post(
            'https://catalog.awsevents.com/api/myData',
            {},
            {
                headers: {
                    'accept': '*/*',
                    'accept-language': 'en-US,en;q=0.9',
                    'content-length': '0',
                    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'rfapiprofileid': rfapiprofileid,
                    'rfauthtoken': rfauthtoken,
                    'rfwidgetid': 'QNo5ySw8IarY51RBuM1VMy8dhCq2uudd',
                    'cookie': cookie,
                    'origin': 'https://registration.awsevents.com',
                    'priority': 'u=1, i',
                    'referer': 'https://registration.awsevents.com/',
                    'sec-ch-ua-mobile': '?0',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-site',
                }
            }
        );

        if (options.saveAgenda) {
            const agendaFile = `${options.outputDir}/agenda.json`;
            console.error(`Saving raw agenda to ${agendaFile}`);
            fs.writeFileSync(agendaFile, JSON.stringify(response.data, null, 2));
        }

        if (!response.data.hasOwnProperty('loggedInUser')) {
            console.error('Unable to download schedule. Please check credentials and try again.\n');
            showHelp();
            process.exit(1);
        }

        const agenda = {
            reserved: transformSessions(response.data.mySchedule, catalog),
            interests: transformSessions(response.data.sessionInterests, catalog),
        };
        console.error(`Downloaded agenda. Found ${agenda.reserved.length} Reservations and ${agenda.interests.length} Interests.`);
        return agenda;
    } catch (error) {
        // Handle errors from the HTTP request
        if (error.response) {
            console.error(`Failed to fetch agenda. HTTP Status: ${error.response.status}`);
        } else {
            console.error(`An error occurred: ${error.message}`);
        }
        process.exit(1);
    }
};

const CSV_HEADINGS = {
    startDay: "Start Day",
    startTime: "Start Time",
    endDay: "End Day",
    endTime: "End Time",
    venue: "Venue",
    room: "Room",
    capacity: "Capacity",
    sessionType: "Session Type",
    sessionId: "Session ID",
    title: "Title",
    topics: "Topic",
    areasOfInterest: "Area of Interest"
};

function exists(obj) {
    return obj !== null && obj !== undefined;
}

function transformSessions(collection, catalog) {
    return collection?.filter(exists)?.map((session) => parseSession(session, catalog))?.filter(exists) ?? [];
}

// Catalog lookup key; codes can contain whitespace that the agenda and the catalog don't agree on
function normalizeCode(code) {
    return String(code ?? '').replace(/\s+/g, '');
}

function indexCatalog(sessions) {
    return new Map(sessions.map((session) => [normalizeCode(session.code), session]));
}

function normalizeFilename(filename) {
    return filename.toLowerCase().replace(/[^a-z]+/, '-');
}

function writeEvents(eventList, outputDir, filename) {
    filename = normalizeFilename(filename);
    ics.createEvents(eventList, (err, icsEvents) => {
        if (err) {
            throw err;
        } else {
            fs.writeFileSync(`${outputDir}/${filename}.ics`, icsEvents);
            console.log(`Wrote ${eventList.length} events to ${outputDir}/${filename}.ics`);
        }
    });
}

function writeCsv(eventList, outputDir, filename) {
    filename = normalizeFilename(filename);
    const eventsWithHeadings = [CSV_HEADINGS, ...eventList];
    const outputEvents = eventsWithHeadings.map((e) => {
        return `${e.startDay},${e.startTime},${e.endDay},${e.endTime},"${e.venue}","${e.room}",${e.capacity},${e.sessionType},"${e.sessionId}","${e.title}","${e.topics}","${e.areasOfInterest}"`;
    });
    fs.writeFileSync(`${outputDir}/${filename}.csv`, outputEvents.join("\n"));
    console.log(`Wrote ${eventList.length} events to ${outputDir}/${filename}.csv`);
}

function toIcsDateTime(unixTimeSec) {
    const unixTimeMs = unixTimeSec * 1000;
    const date = new Date(unixTimeMs);
    return [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1, // ICS months are 1-indexed; JavaScript are 0
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes()
    ];
}

function toCsvDateTime(unixTimeSec) {
    const unixTimeMs = unixTimeSec * 1000;
    const date = DateTime.fromMillis(unixTimeMs).setZone("America/Los_Angeles");
    return { day: date.toFormat("EEE"), time: date.toFormat("HH:mm") }
}

// e.g. "Tue, Dec 1 · 1:30 PM – 2:30 PM PT (60 min)"
function formatTimeRange(startSec, endSec) {
    const start = DateTime.fromSeconds(startSec).setZone(EVENT_TIMEZONE);
    const end = DateTime.fromSeconds(endSec).setZone(EVENT_TIMEZONE);
    const minutes = Math.round(end.diff(start, 'minutes').minutes);
    return `${start.toFormat('ccc, LLL d · h:mm a')} – ${end.toFormat('h:mm a')} PT (${minutes} min)`;
}

// status is { reserved, favorite } for the session in the user's agenda
function sessionToIcs(session, status = {}) {
    const sessionType = session.sessionType;
    const withPrefix = (s, sep) => s ? `${sep}${s}` : '';
    const formatSpeaker = (s) => `${s.name}${withPrefix(s.jobTitle, ' - ')}${withPrefix(s.company, ' - ')}`;
    const speakers = session.speakers?.map(formatSpeaker) ?? [];
    const list = (values) => [...(values ?? [])].sort().join(', ');
    const locationParts = [session.venue, session.room].filter((part) => typeof part === 'string' && part.length > 0);
    const location = locationParts.join(' | ');
    // The catalog has no per-session page; searching by code narrows it to the one session card
    const url = session.sessionId
        ? `${CATALOG_SEARCH_URL}?search=${encodeURIComponent(session.code.toLowerCase())}`
        : undefined;
    const flags = [
        status.reserved && 'Reserved',
        status.favorite && 'Favorite',
        session.walkUpOnly && 'Walk-up only',
    ].filter(Boolean).join(' · ');

    const event = {
        start: toIcsDateTime(session.start),
        startInputType: "utc",
        end: toIcsDateTime(session.end),
        location,
        title: `${session.code} - ${session.title}`,
        status: status.reserved ? 'CONFIRMED' : 'TENTATIVE',
        busyStatus: status.reserved ? 'BUSY' : 'FREE',
        description: [
            [
                formatTimeRange(session.start, session.end),
                [session.venue, session.room].filter(Boolean).join(' — '),
                flags,
            ].filter(Boolean).join('\n'),
            [
                [sessionType, list(session.levels)].filter(Boolean).join(' · '),
                withPrefix(list(session.features), 'Features: '),
                session.capacity ? `Capacity: ${session.capacity}` : '',
            ].filter(Boolean).join('\n'),
            [
                withPrefix(list(session.topics), 'Topics: '),
                withPrefix(list(session.areasOfInterest), 'Areas of Interest: '),
                withPrefix(list(session.roles), 'Roles: '),
            ].filter(Boolean).join('\n'),
            session.abstract,
            speakers.length > 0 ? `Speakers:\n${speakers.join('\n')}` : '',
            url,
        ].filter(Boolean).join('\n\n'),
    };
    // A stable UID lets calendars update an imported event instead of duplicating it
    if (session.uid) {
        event.uid = session.uid;
    }
    if (url) {
        event.url = url;
    }
    return { sessionType, event };
}

function sessionToCsv(session) {
    const start = toCsvDateTime(session.start);
    const end = toCsvDateTime(session.end);
    return {
        startDay: start.day,
        startTime: start.time,
        endDay: end.day,
        endTime: end.time,
        venue: session.venue,
        room: session.room,
        capacity: session.capacity,
        sessionType: session.sessionType,
        sessionId: session.code,
        title: session.title,
        topics: session.topics?.sort()?.join(', ') ?? '',
        areasOfInterest: session.areasOfInterest?.sort()?.join(', ') ?? '',
    };
}

function getAttribute(session, attributeId) {
    return session.attributevalues?.filter((a) => a.attribute_id === attributeId)?.map((a) => a.value) ?? [];
}

function toTitleCase(str) {
    if (typeof str !== 'string' || str.trim().length === 0) {
        return '';
    }

    return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

const SESSION_KINDS = Object.freeze({
    CONFERENCE: 'conference',
    PERSONAL: 'personal',
    UNKNOWN: 'unknown'
});

function getSessionKind(session) {
    if (!session || typeof session !== 'object') {
        return SESSION_KINDS.UNKNOWN;
    }

    const hasCode = typeof session.code === 'string' && session.code.trim().length > 0;
    const isCalendarItem = session.type === 'Calendar Item' || exists(session.calendarItemId);

    if (isCalendarItem && !hasCode) {
        return SESSION_KINDS.PERSONAL;
    }

    if (hasCode) {
        return SESSION_KINDS.CONFERENCE;
    }

    return SESSION_KINDS.UNKNOWN;
}

function warnUnrecognizedSession(session) {
    const title = typeof session?.title === 'string' && session.title.length > 0
        ? session.title
        : (session?.sessionID ?? 'Unknown session');
    console.warn(`Skipping unrecognized session shape for "${title}".`);
}

function sanitizeSessionCode(rawCode, fallback = 'UNKNOWN') {
    if (typeof rawCode === 'string' && rawCode.trim().length > 0) {
        return rawCode.replace(/\s+/, '');
    }
    if (typeof fallback === 'string' && fallback.length > 0) {
        return fallback;
    }
    return 'UNKNOWN';
}

const DEFAULT_SESSION_TYPE = 'Session';

// Agenda attributes first, then the catalog entry; the catalog is the only source for Type, Topic and Area of Interest
function resolveAttribute(session, catalogEntry, attributeId) {
    const fromAgenda = getAttribute(session, attributeId);
    if (fromAgenda.length > 0) {
        return fromAgenda;
    }
    return [...new Set(getAttribute(catalogEntry ?? {}, attributeId))];
}

function resolveSessionType(session, code, catalogEntry) {
    const rawType = getAttribute(session, 'Type')[0] ?? catalogEntry?.type;
    if (typeof rawType === 'string' && rawType.trim().length > 0) {
        return toTitleCase(pluralize.singular(rawType));
    }

    const reason = catalogEntry ? 'has no type in the session catalog' : 'was not found in the session catalog';
    console.warn(`Session "${code}" ${reason}; using type "${DEFAULT_SESSION_TYPE}".`);
    return DEFAULT_SESSION_TYPE;
}

function parseConferenceSession(session, catalog) {
    const toUnixTime = (d) => DateTime.fromFormat(d, 'yyyy/MM/dd HH:mm:ss', {zone: 'UTC'}).toUnixInteger();
    const sessionTime = session.times && session.times.length > 0 ? session.times[0] : {
        room: 'UNKNOWN | UNKNOWN',
        capacity: 0,
        utcStartTime: '2025/11/30 12:00:00',
        utcEndTime: '2025/11/30 13:00:00'
    };
    const [venue, ...room] = sessionTime.room?.split(' | ') ?? ['UNKNOWN', 'UNKNOWN'];
    const fallbackCode = exists(session.sessionID) ? String(session.sessionID) : undefined;
    const code = sanitizeSessionCode(session.code, fallbackCode);
    const catalogEntry = catalog?.get(normalizeCode(code));
    const sessionType = resolveSessionType(session, code, catalogEntry);

    if (!sessionTime.utcStartTime || !sessionTime.utcEndTime) {
        console.warn(`Skipping session "${code}" due to missing UTC start/end time.`);
        return null;
    }

    return {
        code,
        sessionId: session.sessionID,
        uid: sessionTime.sessionTimeID ? `${sessionTime.sessionTimeID}@reinvent-sessions` : undefined,
        title: session.title ?? 'Untitled Session',
        sessionType,
        levels: resolveAttribute(session, catalogEntry, 'Level'),
        features: resolveAttribute(session, catalogEntry, 'Features'),
        roles: resolveAttribute(session, catalogEntry, 'Role'),
        walkUpOnly: resolveAttribute(session, catalogEntry, 'Walkuponlysession').length > 0,
        abstract: session.abstract ?? '',
        speakers: session.participants?.map((p) => ({
            name: p.fullName,
            company: p.companyName,
            jobTitle: p.jobTitle
        })),
        topics: resolveAttribute(session, catalogEntry, 'Topic'),
        areasOfInterest: resolveAttribute(session, catalogEntry, 'AreaofInterest'),
        venue,
        room: room.join(' | '),
        capacity: sessionTime.capacity ?? 0,
        start: toUnixTime(sessionTime.utcStartTime),
        end: toUnixTime(sessionTime.utcEndTime),

    };
}

function parsePersonalTime(session) {
    if (!session || typeof session !== 'object') {
        return null;
    }

    const title = typeof session.title === 'string' && session.title.trim().length > 0
        ? session.title.trim()
        : 'Personal Time';
    const venue = typeof session.location === 'string' ? session.location : '';
    const startLocal = DateTime.fromFormat(`${session.date} ${session.time}`, 'yyyy-MM-dd HH:mm', {
        zone: 'America/Los_Angeles'
    });

    if (!startLocal.isValid) {
        console.warn(`Skipping personal session "${title}" due to invalid date/time.`);
        return null;
    }

    const lengthMinutes = Number(session.length);
    const durationMinutes = Number.isFinite(lengthMinutes) ? lengthMinutes : 0;
    const endLocal = startLocal.plus({minutes: durationMinutes});

    return {
        code: 'PERS',
        uid: exists(session.calendarItemId) ? `${session.calendarItemId}@reinvent-sessions` : undefined,
        title,
        sessionType: 'Personal Time',
        abstract: session.abstract ?? '',
        speakers: [],
        topics: [],
        areasOfInterest: [],
        venue,
        room: '',
        capacity: 0,
        start: startLocal.toUTC().toUnixInteger(),
        end: endLocal.toUTC().toUnixInteger(),
    };
}

function parseSession(session, catalog) {
    const kind = getSessionKind(session);

    switch (kind) {
        case SESSION_KINDS.CONFERENCE:
            return parseConferenceSession(session, catalog);
        case SESSION_KINDS.PERSONAL:
            return parsePersonalTime(session);
        default:
            warnUnrecognizedSession(session);
            return null;
    }
}

async function exportSessions(options, command) {
    const outputDir = options.outputDir;
    const catalogDir = options.catalog;
    fs.mkdirSync(`./${outputDir}`, {recursive: true});
    fs.mkdirSync(`./${catalogDir}`, {recursive: true});

    const catalog = await loadCatalog(catalogDir);
    const {reserved, interests} = await fetchAgenda(options, catalog);
    const reservedIds = new Set(reserved.map((s) => s.sessionId).filter(exists));
    const favoriteIds = new Set(interests.map((s) => s.sessionId).filter(exists));

    if (!options.reservedOnly) {
        const events = {};
        interests.map((s) => sessionToIcs(s, {
            reserved: reservedIds.has(s.sessionId),
            favorite: true,
        })).forEach(({sessionType, event}) => {
            if (!events.hasOwnProperty(sessionType)) {
                events[sessionType] = [];
            }
            events[sessionType].push(event);
        });

        let allEvents = [];
        for (const eventType in events) {
            allEvents = allEvents.concat(events[eventType]);
            writeEvents(events[eventType], outputDir, `${eventType}s`);
        }
        writeEvents(allEvents, outputDir, 'all-sessions');

        const csvEvents = interests.map(sessionToCsv);
        writeCsv(csvEvents, outputDir, 'all-sessions');
    }

    if (reserved.length > 0) {
        writeEvents(reserved.map((r) => sessionToIcs(r, {
            reserved: true,
            favorite: favoriteIds.has(r.sessionId),
        }).event), outputDir, "reserved");
    }
}

program
    .name('sessions-to-ics')
    .version('2024.0.0')
    .showHelpAfterError(true)
    .option('-o, --output-dir <dir>', 'the output directory', 'sessions')
    .option('-r, --reserved-only', 'Only output reserved sessions')
    .option('-a, --save-agenda', 'Save the raw agenda JSON to <dir>/agenda.json')
    .option('-c, --catalog <dir>', 'the directory for the cached session catalog (sessions.json)', 'catalog')
    .action(exportSessions)
    .parse();
