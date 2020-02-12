## Running MLST

[![pipeline status](https://gitlab.com/cgps/cgps-mlst/badges/master/pipeline.svg)](https://gitlab.com/cgps/cgps-mlst/commits/master)

You can manually run seven gene as follows:

```
cat FILE_TO_BE_TYPED.fasta | docker run -i --rm registry.gitlab.com/cgps/cgps-mlst:latest --taxid=1280
# or
cat FILE_TO_BE_TYPED.fasta | docker run -i -e TAXID=ORGANISM_TAXID --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

For example:

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e TAXID=1280 --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

You can get information for debugging by passing in the `DEBUG` environment variable:

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e TAXID=1280 -e DEBUG='cgps:*,-cgps:trace*' --rm registry.gitlab.com/cgps/cgps-mlst:mlst-v1.5.58
```

The output data also includes more details if you set the `DEBUG` environment variable.  This includes
the position of the best match and any other close matches.  You can see this without much clutter
by setting `DEBUG='.'`.

You can run Core Genome MLST by running the `cgmlst` container instead of the `mlst` container.

```
cat tests/testdata/saureus_duplicate.fasta | docker run -i -e TAXID=1280 -e DEBUG='cgps:*' --rm registry.gitlab.com/cgps/cgps-mlst:cgmlst-v1.5.58
```

## Making a release

You might want to update the databases in [CGPS Typing scripts](https://gitlab.com/cgps/cgps-typing-databases/) before running a release.
This can take an hour or more for a complete update.

The following script will bump the version, make a git tag, push the code and build it using out CI
pipeline.  It will trigger some quick tests.

```
./bin/release.sh
```

You should then wait and see if the quick-tests pass.  If they do, you can build containers
using our CI system.

On the [Pipelines page](https://gitlab.com/cgps/cgps-mlst/pipelines), click `New Pipeline`.
Pick the version of the code you want to build (probably the tag you just committed).
Give the pipeline the following environment variables:

* cgmlst: `RUN_CORE_GENOME_MLST = yes`
* mlst: `RUN_CORE_GENOME_MLST = no`
* alternative mlst schemes: `INDEX_PARAMS = --type alternative_mlst; SCHEME_NAME = alternative-mlst`
* ngstar: `INDEX_PARAMS = --scheme ngstar; SCHEME_NAME = ngstar`

## How it works

This project loads typing databases which have been collected using the [CGPS Typing scripts](https://gitlab.com/cgps/cgps-typing-databases/).  These
scripts download data from a variety of sources and reformat them consistently.  You should probably update the databases and push your changes
before making a release.  This might take an hour or two if you are trying to update all of the databases at once.

This project indexes the typing databases so that typing can be run quickly.  This includes hashing all known alleles of each locus.

Genomes are typed by searching for exact matches and by calling Blast.  Exact matches are found by looking for prefixes and in the assembly and
then comparing the hash of a sequence with a list of known hashes.

Blast is used to identify novel alleles (i.e. ones which are not included in the database).  This is done in a couple of rounds.  The first round Blasts
a small number of alleles against the genome to identify areas which might contain alleles.  The results of this intial round are compared with the
results of the exact matching to identify which (if any) loci might have novel hits.

A second round of Blast uses a larger number of alleles for each locus, but only for the loci which the previous step showed might have a novel allele.
Currently this includes all known alleles for MLST and a selection of 50 alleles for cgMLST.

Each locus can have more than one hit for a given genome (which may an artifact of the specimine, an assembly error, contamination, etc.).  It is important
to identify cases where hits from Blast or exact matching overlap for a given locus; some databases include alleles which are truncations of one another and
we want to return the "best" result.

Broadly speaking the algorithm could be considered as follows:
* For each locus, create bins containing exact and inexact hits which overlap by more than 80% on a given contig of the assembly
* Assess which the best hit is for each locus in each bin
* Report those hits (i.e. normally one per locus, but sometimes multiple)

Best is defined as follows for a given bin of hits for a given locus in the database:
* If there are any exact hits, return the longest, if not
* Discard hits which cover less than 80% of the length of the specified allele
* Find the hit with the greatest percentage identity
* Discard any hits which are 2% worse than the best percentage identity
* Return the hit with the most matching bases
* To break ties, return the but with the greatest percentage identity

## Building the containers locally

7 gene MLST and Core Genome MLST use the same code but different databases
which you build into two separate containers.  This means that you can
update the databases independently.

There are three stages to building the containers:

* Clone the databases
* Index the data
* Build the container

### Download the data

Clone the [CGPS Typing scripts](https://gitlab.com/cgps/cgps-typing-databases/) repo.  You might want to update the databases and push your changes.

### Index the data

The previous step downloaded data, this needs to be indexed before we can
use it to call STs.  This formats the data into a consistent format and
calculates things like hashes of alleles to enable quick exact matches.

For MLST:

```
DEBUG='cgps:info' npm run index -- --type=mlst --index=index_dir --database=cgps-typing-databases
```

For ngstar:

```
DEBUG='cgps:info' npm run index -- --type=ngstar --index=index_dir --database=cgps-typing-databases
```

For cgMLST:

```
DEBUG='cgps:info' npm run index -- --type=cgmlst --max-sequences 50 --index=index_dir --database=cgps-typing-databases
```

NB These commands overwrite the results of one another, you might want to `mv index_dir{,.bak}` between commands

### Building the containers

For MLST:

```
docker build --build-arg RUN_CORE_GENOME_MLST='no' --target prod_build -t mlst:latest .
```

For cgMLST:

```
docker build --build-arg RUN_CORE_GENOME_MLST='yes' --target prod_build -t cgmlst:latest .
```

### Running the tests

Download and index the databases you want to test with.  Then build a container
for testing:

```
docker build --target test_build -t mlst-test .
```

This container only includes the dependencies (e.g. Blast) which you need for testing.  You need to mount the code, tests, and index when you run the tests:

```
docker run -i --rm \
      -v $(pwd):/usr/local/mlst \
      -v /usr/local/mlst/node_modules \
      -w /usr/local/mlst \
      -e DEBUG='cgps:*,-cgps:trace*' \
      -e RUN_CORE_GENOME_MLST=no \
      mlst-test \
        npm run test
```

To run the cgmlst tests, you need to update the index and then run:
```
docker run -i --rm \
      -v $(pwd):/usr/local/mlst \
      -v /usr/local/mlst/node_modules \
      -w /usr/local/mlst \
      -e DEBUG='cgps:*,-cgps:trace*' \
      -e RUN_CORE_GENOME_MLST=yes \
      mlst-test \
        npm run test
```

You can also run the "quick-test" which only run a subset of tests.  To run these, index the MLST schemes and then the ngstar schemes as show above.  Then run:
```
docker run -i --rm \
      -v $(pwd):/usr/local/mlst \
      -v /usr/local/mlst/node_modules \
      -w /usr/local/mlst \
      -e DEBUG='cgps:*,-cgps:trace*' \
      -e RUN_CORE_GENOME_MLST=no \
      mlst-test \
        npm run quick-test
```
