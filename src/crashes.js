import Router from 'koa-router';
import moment from 'moment';
import {
  median,
  standardDeviation,
  geometricMean,
  mean,
  quantile,
 } from 'simple-statistics';
import {
   uniq,
   flatten,
   sumBy,
   zipObject,
   without,
   countBy,
   sortBy,
   toPairs,
   find,
 } from 'lodash';
import qs from 'qs';
import { parse as parseVersion } from './meta/version';
import fetchJson from './fetch/json';
import fetchRedash from './fetch/redash';
import fetchCrashStats from './fetch/crash-stats';
import { getHistory } from './release/history';
// import { getAdi } from './crashes/adi';

const dateBlacklist = [
  '2016-05-01',
  '2016-05-03',
  '2016-05-04',
  '2016-05-07',
  '2016-05-08',
  '2016-06-03',
  '2016-07-04',
];
const target = moment('2015-01-15', 'YYYY MM DD');
const baseline = moment('2016-01-17', 'YYYY MM DD');

export const router = new Router();

const bandwidth = 7;
const weeklyAverage = (result, idx, results) => {
  if (idx < bandwidth) {
    return result;
  }
  const weekRate = results
    .slice(idx - bandwidth, idx + bandwidth).map(past => past.dirty);
  const avg = mean(weekRate);
  result.rate = avg;
  return result;
};

router
  .get('/adi', async (ctx) => {
    const product = (ctx.request.query.product === 'fennec') ? 'fennec' : 'firefox';
    const full = (ctx.request.query.full === '1');
    // const adis = await getAdi({
    //   product: product,
    //   channel: 'release',
    //   dateRange: [target, moment()],
    // });
    // console.log(adis);
    const urls = {
      fennec: 'https://crash-analysis.mozilla.com/rkaiser/FennecAndroid-release-bytype.json',
      firefox: 'https://crash-analysis.mozilla.com/rkaiser/Firefox-release-bytype.json',
    };
    const raw = await fetchJson(urls[product]);
    const baselines = [0, 0, 0];
    const ratesByDay = Object.keys(raw)
      .map((date) => {
        const entry = raw[date];
        const dirty = (entry.crashes.Browser / entry.adi) * 100;
        let oldRate = dirty;
        const day = moment(date, 'YYYY MM DD').format('dd');
        // Deseasonalize with hardcoded seasonality index
        if (product === 'firefox') {
          oldRate *= {
            Fr: 0.99,
            Sa: 0.91,
            Su: 0.92,
            Mo: 1,
          }[day] || 1;
        } else {
          oldRate *= {
            Fr: 0.99,
            Sa: 0.93,
            Su: 0.895,
            Mo: 0.99,
          }[day] || 1;
        }
        return { date, dirty, oldRate };
      })
      .filter(({ dirty }) => dirty > 0.5) // Remove outages
      .map(weeklyAverage)
      .filter((result, idx, results) => {
        const time = moment(result.date, 'YYYY MM DD');
        if (!time.diff(target, 'days')) {
          // Target from 14 day average
          baselines[0] = mean(
            results.slice(idx - bandwidth, idx + bandwidth).map(past => past.rate),
          );
        }
        if (!time.diff(baseline, 'days')) {
          // Baseline from 10 day average
          baselines[1] = mean(
            results.slice(idx - bandwidth, idx + bandwidth).map(past => past.rate),
          );
          baselines[2] = result.oldRate;
        }
        // Only show 4 days before baseline in the chart
        return (time.diff(full ? target : baseline, 'days') >= -4);
      });
    ctx.body = {
      baselines: [
        { date: target.toDate(), rate: baselines[0] },
        {
          date: baseline.toDate(),
          rate: baselines[1],
          oldRate: baselines[2],
        },
      ],
      rates: ratesByDay,
    };
  })

  .get('/', async (ctx) => {
    const raw = await fetchRedash(331);
    const reduced = raw.query_result.data.rows
      .map((row) => {
        return {
          date: row.activity_date,
          dirty: row.main_crash_rate,
        };
      })
      .filter(({ date }) => {
        return dateBlacklist.indexOf(date) < 0;
      })
      .map(weeklyAverage);
    ctx.body = reduced;
  })

  .get('/beta', async (ctx) => {
    const raw = await fetchRedash(475);
    const results = raw.query_result.data.rows.map((row) => {
      return {
        date: row.activity_date,
        rate: row.main_crash_rate,
      };
    });
    ctx.body = results;
  })

  .get('/xp', async (ctx) => {
    const nonXpRates = await fetchRedash(689);
    const xpRates = await fetchRedash(690);
    const raw = await fetchRedash(331);
    ctx.body = [
      nonXpRates.query_result.data.rows
        .map((row) => {
          return {
            date: row.activity_date,
            rate: row.main_crash_rate,
          };
        })
        .filter(({ date }) => {
          return dateBlacklist.indexOf(date) < 0;
        }),
      xpRates.query_result.data.rows
        .map((row) => {
          return {
            date: row.activity_date,
            rate: row.main_crash_rate,
          };
        })
        .filter(({ date }) => {
          return dateBlacklist.indexOf(date) < 0;
        }),
      raw.query_result.data.rows
        .map((row) => {
          return {
            date: row.activity_date,
            rate: row.main_crash_rate,
          };
        })
        .filter(({ rate, date }) => {
          return rate > 3 && dateBlacklist.indexOf(date) < 0;
        }),
    ];
  })

  .get('/beta/builds', async (ctx) => {
    const history = await getHistory({
      channel: 'beta',
      tailVersion: 5,
    });
    const betaRaw = (await fetchRedash(2856)).query_result.data.rows;
    // const betaE10sRaw = sortBy(
    //   (await fetchRedash(497)).query_result.data.rows,
    //   'activity_date',
    //   (a) => Date.parse(a)
    // );

    const builds = betaRaw.reduce((lookup, row) => {
      const buildDate = moment(row.build_id, 'YYYYMMDD');
      const release = find(history, ({ date }) => {
        const diff = moment(date, 'YYYY MM DD').diff(buildDate, 'day');
        return diff >= 0 && diff <= 2;
      });
      const result = {
        date: buildDate.format('YYYY-MM-DD'),
        release: release && release.date,
        candidate: release
          ? parseVersion(release.version).candidate
          : 'rc',
        build: row.build_id,
        version: row.build_version,
        hours: row.usage_kilohours,
        rate: row.main_crash_rate,
        rateContent: row.content_crash_rate,
        dates: [],
      };
      lookup.push(result);
      return lookup;
    }, []);

    const releases = builds.reduce((lookup, result) => {
      let entry = find(lookup, ({ version }) => version === result.version);
      if (!entry) {
        entry = {
          version: result.version,
          builds: [],
        };
        lookup.push(entry);
      }
      entry.builds.push(result);
      return lookup;
    }, []);
    releases.forEach((release) => {
      release.hours = sumBy(release.builds, 'hours');
      const rates = release.builds
        .map(({ rate }) => rate)
        .filter(rate => rate > 0);
      if (rates.length > 0) {
        release.rate = geometricMean(rates) || 0;
        release.variance = standardDeviation(rates) || 0;
      }
    });
    ctx.body = releases;
  })

  .get('/urls', async (ctx) => {
    // const archive = (await getHistory({ tailVersion: 5 })).reverse();
    const sites = [
      'mail.google.com',
      'facebook.com',
      'youtube.com',
      'yahoo.com',
      'web.whatsapp.com',
      'twitter.com',
      'yandex.ru',
      'mail.yandex.ru',
      'www.google.com',
      'docs.google.com',
      'tumblr.com',
      'mail.ru',
      'ok.ru',
      'wetransfer.com',
      'outlook.live.com',
    ];
    const crashIndex = await Promise.all(
      sites.map(async (host) => {
        return fetchCrashStats({
          product: 'Firefox',
          release_channel: 'release',
          version: '46.0.1',
          process_type: 'browser',
          url: `~${host}/`,
          _facets: 'signature',
          _facets_size: '50',
          _results_number: '0',
        });
      }),
    );

    const signatureMap = crashIndex.map((data) => {
      return data.facets.signature.map(signature => signature.term);
    });
    const signatureIds = uniq(flatten(signatureMap));

    const bugIndex = (await Promise.all(signatureIds.map((signature) => {
      return fetchCrashStats({
        signatures: signature,
      }, {
        endpoint: 'Bugs',
      });
    }))).map((result) => {
      return result.hits
        // .filter((hit) => hit.signature === signatureIds[i])
        .map(hit => hit.id);
    });
    const bugIds = uniq(flatten(bugIndex));
    const query = {
      id: bugIds.join(','),
      product: 'Core',
      include_fields: 'id,component',
    };
    const bugsUrl = `https://bugzilla.mozilla.org/rest/bug?${qs.stringify(query)}`;

    const componentMap = (await fetchJson(bugsUrl, { ttl: 'day' })).bugs
      .reduce((bugs, { id, component }) => {
        bugs[id] = component && component.split(': ')[0];
        return bugs;
      }, {});

    const signatureToBugs = zipObject(signatureIds, bugIndex);

    const siteAggregate = sites.map((site, siteIdx) => {
      const data = crashIndex[siteIdx];
      const components = sortBy(
        data.facets.signature.reduce((counted, signature) => {
          let component = '';
          let convidence = 1;
          if (/^shutdownhang/.test(signature.term)) {
            return counted;
          }
          if (/^OOM/.test(signature.term)) {
            component = 'OOM';
          } else {
            const bugs = signatureToBugs[signature.term];
            const sorted = sortBy(
              toPairs(
                countBy(
                  without(
                    bugs.map(bug => componentMap[bug]),
                    'Untriaged', 'XPCOM', undefined,
                  ),
                ),
              ),
              1,
            );
            if (!sorted.length) {
              return counted;
            }
            sorted.reverse();
            convidence = sorted[0][1] / bugs.length;
            component = sorted[0][0];
          }
          if (!component) {
            return counted;
          }
          const existing = find(counted, { name: component });
          if (!existing) {
            counted.push({
              name: component,
              convidence,
              ratio: signature.count,
              signatures: [signature.term],
              bugs: [],
            });
          } else {
            existing.ratio += signature.count;
            existing.signatures.push(signature.term);
          }
          return counted;
        }, []),
        'ratio',
      ).reverse();
      const componentSum = sumBy(components, 'ratio');
      components.forEach((entry) => {
        entry.ratio /= componentSum;
        // Object.keys(componentMap).forEach((bug) => {
        //   if () {
        //
        //   }
        //   const component = componentMap[bug];
        //   if (component === entry.name) {
        //     entry.bugs
        //   }
        // });
      });
      return {
        site,
        components,
        ratio: data.total,
      };
    });

    const crashSum = sumBy(siteAggregate, 'ratio');
    siteAggregate.forEach((entry) => {
      entry.ratio /= crashSum;
    });

    ctx.body = sortBy(siteAggregate, 'ratio').reverse();
  });
