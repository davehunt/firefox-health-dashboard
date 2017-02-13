import moment from 'moment';
import ical from 'ical';
import fetchText from '../fetch/text';
import { parse } from '../meta/version';

export default async function getCalendar({
  channel = 'release',
} = {}) {
  const url = 'https://calendar.google.com/calendar/ical/mozilla.com_2d37383433353432352d3939%40resource.calendar.google.com/public/basic.ics';
  const ics = await fetchText(url);
  const parsed = ical.parseICS(ics);
  const dates = Object.keys(parsed).reduce((data, key) => {
    const entry = parsed[key];
    if (moment().diff(entry.start, 'days') >= 0) {
      return data;
    }
    const summary = entry.summary.match(/Firefox\s+(ESR)?\s*([\d.]+)\s+Release/);
    if (!summary) {
      return data;
    }
    const ch = summary[1] ? 'esr' : 'release';
    if (channel && ch !== channel) {
      return data;
    }
    const { clean } = parse(summary[2]);
    data.push({
      version: clean,
      channel: ch,
      date: moment(entry.start).format('YYYY-MM-DD'),
    });
    return data;
  }, []);
  dates.sort((a, b) => ((a.date < b.date) ? -1 : 1));
  if (!dates.length) {
    dates.push({
      version: '52',
      channel: 'release',
      date: '2017-03-07',
    });
    dates.push({
      version: '53',
      channel: 'release',
      date: '2017-04-18',
    });
    dates.push({
      version: '54',
      channel: 'release',
      date: '2017-06-13',
    });
    dates.push({
      version: '55',
      channel: 'release',
      date: '2017-08-08',
    });
  }
  return dates;
}
