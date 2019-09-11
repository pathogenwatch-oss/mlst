## Running MLST

[![pipeline status](https://gitlab.com/cgps/cgps-mlst/badges/master/pipeline.svg)](https://gitlab.com/cgps/cgps-mlst/commits/master)

You can manually run seven gene as follows:

```
cat FILE_TO_BE_TYPED.fasta | docker run -i -e WGSA_ORGANISM_TAXID=ORGANISM_TAXID --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
# or
cat FILE_TO_BE_TYPED.fasta | docker run -i -e WGSA_ORGANISM_TAXID=ORGANISM_TAXID --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

For example:

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

You can get information for debugging by passing in the `DEBUG` environment variable:

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*,-trace*' --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

The output data also includes more details if you set the `DEBUG` environment variable.  This includes 
the position of the best match and any other close matches.  You can see this without much clutter 
by setting `DEBUG='.'`.

You can run Core Genome MLST by running the `cgmlst` container instead of the `mlst` container.

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*' --rm registry.gitlab.com/cgps/cgps-mlst:cgmlst-v1.5.58
```

## Making a release

The following script will bump the version, make a git tag, push the code and build it using out CI
pipeline.  It will also (slowly) run some tests.

```
./bin/release.sh
```

We cache the downloads between builds for speed and to be polite.  If you've made a significant change or
just need the latest data, trigger the build pipeline manually and it will clear the cache.

## Building the containers locally

7 gene MLST and Core Genome MLST use the same code but different databases 
which you build into two separate containers.  This means that you can 
update the databases independently.

There are two stages to building the containers:

* Download the data from public sources
* Index the data

### Download the data

Some of the sources we use for schemes have issues which means that the 
download can be interupted.  The script is designed so that you can identify 
downloads which have failed and resume the download.

We mount the code into a container and mount another directory to cache 
the results of the download.

You will need an API key from Enterobase so that we can download their 
schemes.

```
docker run -it --rm \
    -v $(cd data && pwd):/opt/mlst \
    -v $(pwd):/src:ro \
    -w /src \
    -e DEBUG='cgps:*' \
    node:8 \
        npm run download
```

or for cgmlst:

```
docker run -it --rm \
    -v $(cd data && pwd):/opt/mlst \
    -v $(pwd):/src:ro \
    -w /src \
    -e ENTEROBASE_API_KEY="your enterobase api key" \
    -e RUN_CORE_GENOME_MLST='yes' \
    -e DEBUG='cgps:*' \
    node:8 \
        npm run download
```

Downloaded files are stored in `data/cache` in a hierarcy similar to 
their URL.

You can also update just a section of the data by deleting the relevant 
files from the cache and rerunning this command.

### Index the data

The previous step downloaded data, this needs to be indexed before we can 
use it to call STs.  This formats the data into a consistent format and 
calculates things like hashes of alleles to enable quick exact matches.

We build separate containers for 7 gene and core genome MLST as follows.

```
docker build -t mlst .
docker build -t cgmlst --build-arg RUN_CORE_GENOME_MLST=yes .
```

## Running the tests

Building the databases takes quite a long time so, if you don't need to test 
the database building code, it's better to pull a container with a database 
and test the code there.

To test 7 gene MLST:

```
docker run --rm -it \
    -v $(pwd):/usr/local/mlst \
    -w /usr/local/mlst/tests \
    <EXISTING_DOCKER_CONTAINER> \
        npm test
```

You can use the same command with a Core Genome MLST container.  The tests 
should also be run automatically when you build a new container.

## TODO

* Add more quick tests which don't need a database or blast to tell if something
  has been broken.