require('dotenv').config();

if (!process.env.BIGTIME_USERNAME) throw new Error('Missing BIGTIME_USERNAME environment variable.')
if (!process.env.BIGTIME_PASSWORD) throw new Error('Missing BIGTIME_PASSWORD environment variable.')

const BigTime = require('bigtime-sdk'),
      bigTime = new BigTime({
        username: process.env.BIGTIME_USERNAME,
        password: process.env.BIGTIME_PASSWORD
      }),
      fs = require('fs-extra'),
      moment = require('moment'),
      changeCase = require('change-case'),
      queue = require('async/queue'),
      createTimeEntryQueue = queue(createTimeEntryWorker),
      utils = require('./utils'),
      blackListedProjectNames = [ // TODO: Move this to an environment variable
        'Active Network, LLC',
        'Love for Sports',
        'Verys LLC:Strikers',
        'Verys LLC:Vacation',
        'ZeniMax Media Inc.:CDP Admin Fixed Fee',
        'ZeniMax Media Inc.'
      ];

let rawResponseBody = null,
    transformedData = {
      data: {
        byProject: {},
        byDate: {}
      },
      meta: {
        averageDailyHours: 0,
        projectCount: 0,
        entryCount: 0,
        dateCount: 0,
        totalHours: 0,
        projects: []
      }
    },
    sampleData = [],
    weightedProjectData = [],
    randomEntry = null,
    randomTime = null,
    submitEnd = null;

bigTime.createSession()
  .then(
    response => {
      return bigTime.getTimeSheetDateRange({
        StartDt: moment().subtract(Number(process.env.BIGTIME_SAMPLE_DATA_START_VALUE), process.env.BIGTIME_SAMPLE_DATA_START_KEY).format('YYYY-MM-DD')
      })
    }
  )
  .then(
    response => {
      rawResponseBody = response.body;
      transform();
      appendMetaData();
      weightProjectData();
      setupSampleData();
      return getPreexistingData();
    },
    () => {
      console.log('Error fetching timesheet range data.');
      process.exit(1);
    }
  )
  .then(
    response => {
      preexistingData = response.body;
      populateSampleData();
      queueSubmittals();
      const now = moment(),
            month = utils.zeroPad(now.month() + 1),
            day = utils.zeroPad(now.date()),
            filename = `./results/${now.year()}-${month}-${day}-${now.valueOf()}.json`;
      fs.outputFile(filename, JSON.stringify(sampleData, null, 2), err => {
        if (err) throw err;
        utils.logger.info(`Saved results to ${filename}`);
      });
    },
    err => {
      console.log('Error fetching pre-existing data.', err);
      process.exit(1);
    }
  );

/**
 * [createTimeEntryWorker description]
 *
 * @param  {Object}   entry
 * @param  {Function} callback
 * @return {undefined}
 */
function createTimeEntryWorker (entry, callback) {
  bigTime.createTimeEntry({
    Dt: entry.date,
    ProjectSID: entry.projectSid,
    BudgCatID: 129171, // TODO: Don't hardcode this
    Hours_IN: entry.hours
  })
  .then(
    () => setTimeout(() => callback(), 2000), // Respect the API limt of 1 request every 2 seconds
    () => {
      console.log('Error creating time entry.');
      process.exit(1);
    }
  )

}

/**
 *
 * @return {undefined}
 */
createTimeEntryQueue.drain = () => console.log('Done');

/**
 * [transform description]
 *
 * @return {undefined}
 */
function transform() {
  rawResponseBody.forEach(entry => {
    // let reducedEntry = reduceEntry(entry);
    if (!transformedData.data.byProject[entry.ProjectSID]) transformedData.data.byProject[entry.ProjectSID] = [];
    transformedData.data.byProject[entry.ProjectSID].push(entry);

    if (!transformedData.data.byDate[entry.Dt]) transformedData.data.byDate[entry.Dt] = [];
    transformedData.data.byDate[entry.Dt].push(entry);
  });
}

/**
 * [appendMetaData description]
 *
 * @return {undefined}
 */
function appendMetaData() {
  let projectKeys = Object.keys(transformedData.data.byProject),
      dateKeys = Object.keys(transformedData.data.byDate);

  transformedData.meta.entryCount = rawResponseBody.length;
  transformedData.meta.projectCount = projectKeys.length;
  transformedData.meta.dateCount = dateKeys.length;
  dateKeys.forEach(dateKey => {
    transformedData.data.byDate[dateKey].forEach((entry) => {
      transformedData.meta.totalHours += entry.Hours_IN;
    });
  });
  projectKeys.forEach(projectKey => {
    let project = transformedData.data.byProject[projectKey],
        totalEntries = project.length,
        totalHours = null,
        projectName = null,
        projectSid = null,
        clientName = null,
        clientId = null;
    project.forEach((entry) => {
      totalHours += entry.Hours_IN;
      projectName = entry.ProjectNm;
      clientName = entry.ClientNm;
      projectSid = entry.ProjectSID;
      clientId = entry.ClientID;
    });
    transformedData.meta.projects.push({
      projectName,
      projectSid,
      clientName,
      clientId,
      totalHours,
      totalEntries,
      averageEntryHours: totalHours / totalEntries
    });
  });
  transformedData.meta.averageDailyHours = transformedData.meta.totalHours / dateKeys.length;
}

/**
 * [weightProjectData description]
 *
 * @return {undefined}
 */
function weightProjectData() {
  transformedData.meta.projects.forEach(project => {
    for (let i = 0; i < project.totalEntries; i++) {
      if (!blackListedProjectNames.includes(project.projectName)) weightedProjectData.push(project);
    }
  });
}

/**
 * [setupSampleData description]
 *
 * @return {undefined}
 */
function setupSampleData() {
  for (let i = 0; i < Number(process.env.BIGTIME_SAMPLE_NUM_ENTRIES); i++) {
    sampleData.push([]);
  }
}

/**
 * [getPreexistingData description]
 *
 * @return {Promise}
 */
function getPreexistingData() {
  submitEnd = moment();
  const end = submitEnd.format('YYYY-MM-DD')
        submitStartMoment = moment(end).subtract(sampleData.length - 1, 'days'),
        submitStartYear = submitStartMoment.year(),
        submitStartMonth = utils.zeroPad(submitStartMoment.month() + 1),
        submitStartDate = utils.zeroPad(submitStartMoment.date()),
        start = `${submitStartYear}-${submitStartMonth}-${submitStartDate}`;
  return bigTime.getTimeSheetDateRange({StartDt: start, EndDt: end})
}

/**
 * [populateSampleData description]
 *
 * @private
 * @return {undefined}
 */
function populateSampleData() {
  sampleData.forEach((day, i) => {
    const entrySubmit = moment(submitEnd).subtract(i, 'days'),
          entrySubmitYear = entrySubmit.year(),
          entrySubmitMonth = utils.zeroPad(entrySubmit.month() + 1),
          entrySubmitDate = utils.zeroPad(entrySubmit.date()),
          date = `${entrySubmitYear}-${entrySubmitMonth}-${entrySubmitDate}`;
    while (getTotalLoggedTimeForDay(day, date) < Number(process.env.BIGTIME_SAMPLE_MIN_DAILY_HOURS)) {
      setRandomEntry();
      setRandomTime();
      let newTotal = Number(getTotalLoggedTimeForDay(day) + randomTime);
      if (newTotal < Number(process.env.BIGTIME_SAMPLE_MAX_DAILY_HOURS)) {
        randomEntry.hours = randomTime;
        randomEntry.date = date;
        sampleData[i].push(Object.assign({}, randomEntry));
      }
    }
  });
}

/**
 * [getTotalLoggedTimeForDay description]
 *
 * @param  {Array} day
 * @param  {String} date
 * @return {undefined}
 */
function getTotalLoggedTimeForDay(day, date) {
  let totalLoggedTime = 0,
      totalExistingTime = 0,
      existing = preexistingData.filter(item => item.Dt === date);
  existing.forEach(e => totalLoggedTime = Number(totalLoggedTime + e.Hours_IN));
  day.forEach(entry => totalLoggedTime = Number(totalLoggedTime + entry.hours));
  return totalLoggedTime;
}

/**
 * [setRandomEntry description]
 *
 * @private
 * @return {undefined}
 */
function setRandomEntry() {
  const randomIndex = Number(Math.floor(Math.random() * weightedProjectData.length)),
        entry = weightedProjectData[randomIndex];
  randomEntry = entry;
}

/**
 * [setRandomTime description]
 *
 * @private
 * @return {undefined}
 */
function setRandomTime() {
  const increments = 60 / Number(process.env.BIGTIME_SAMPLE_TIME_INCREMENT_MINUTES),
        percentage = 100 / increments,
        method = Math.random() < 0.5 ? 'ceil' : 'floor',
        hours = Math[method](randomEntry.averageEntryHours),
        minutes = (Math.floor(Math.random() * increments) * percentage) / 100,
        total = Number(hours + minutes);
  randomTime = total;
}

/**
 * [queueSubmittals description]
 *
 * @private
 * @return {undefined}
 */
function queueSubmittals() {
  sampleData.forEach((day) => {
    day.forEach(entry => {
      createTimeEntryQueue.push(entry);
    });
  });
}