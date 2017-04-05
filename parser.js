const fs = require('fs');
const getStdin = require('get-stdin');

function handleError(err) {
  console.error(err);
  process.exit(1);
}

function parseResults(data) {
  const lines = (
    data
      .split('\n')
      .map(
        line => line.split(',').map(x => x.replace(/^\"/, '').replace(/\"$/, ''))
      )
  );
  const st = lines[1][2];
  const code = lines[1].filter((item, index) => index > 2).join('_');
  return { st,  code };
}

function printResults(results) {
  console.log(
    JSON.stringify(
      results
    )
  );
}

getStdin()
  .then(parseResults)
  .then(printResults)
  .catch(handleError);
