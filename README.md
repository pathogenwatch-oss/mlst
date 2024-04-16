# CGPS MLST/cgMLST profile assignments
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
### Full release
- Create an updated typing database image following the instructions in [CGPS Typing scripts](https://gitlab.com/cgps/pathogenwatch/analyses/typing-databases/).
- Update the `.env` file with the code and typing database image versions.
- Run `./build-all.sh`

### Individual species releases.
First, if the code has changed you'll need to build a new version of the code image. Otherwise, just reuse the last one.
```
docker build --rm -t registry.gitlab.com/cgps/cgps-mlst/mlst-code:v3.2.1 -f Dockerfile.code .
```

The next step is to create an updated typing database image following the instructions in [CGPS Typing scripts](https://gitlab.com/cgps/pathogenwatch/analyses/typing-databases/).
This can take an hour or more for a complete update. It is also possible to do various partial updates (e.g. a single scheme or cgmlst-only).

Then create a new imagdockere of the indexed schemes by running:
```
# For a single scheme
docker build --rm --build-arg SCHEME=klebsiella_1 --build-arg DB_TAG=2208231334 --build-arg CODE_VERSION=v3.2.1 --build-arg TYPE=cgmlst -t registry.gitlab.com/cgps/cgps-mlst/mlst-data:2208231334_klebsiella_1 -f Dockerfile.schemes .
```

Finally, create the integrated cgmlst image by running:
```
docker build --rm --build-arg DATA_NAME=cgmlst --build-arg DATA_VERSION=2023041203-klebsiella_1-v3.2.1 --build-arg CODE_VERSION=v3.2.1 --build-arg RUN_CORE_GENOME_MLST=yes -t registry.gitlab.com/cgps/cgps-mlst/cgmlst:2023041203-klebsiella_1-v3.2.1 .
```

## How it works

This project loads typing databases which have been collected using the [CGPS Typing scripts](https://gitlab.com/cgps/cgps-typing-databases/).  These
scripts download data from a variety of sources and reformat them consistently.  The build is stored as a docker image.
This will take several hours if you are trying to update all of the databases at once.

This project indexes the typing databases so that typing can be run quickly.  This includes hashing all known alleles of each locus.

Genomes are typed by searching for exact matches and by calling Blast.  Exact matches are found by looking for prefixes and in the assembly and
then comparing the hash of a sequence with a list of known hashes.

Blast is used to identify novel alleles (i.e. ones which are not included in the database).  This is done in a couple of rounds.  The first round Blasts
a small number of alleles against the genome to identify areas which might contain alleles.  The results of this intial round are compared with the
results of the exact matching to identify which (if any) loci might have novel hits.

A second round of Blast uses a larger number of alleles for each locus, but only for the loci which the previous step showed might have a novel allele.

Each locus can have more than one hit for a given genome (which may an artifact of the specimine, an assembly error, contamination, etc.).  It is important
to identify cases where hits from Blast or exact matching overlap for a given locus; some databases include alleles which are truncations of one another and
we want to return the "best" result.

There are two parts to the algorithm for historical reasons. This section describes the core search process once exact hits have been identified.
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

Finally, in the second part all matches are resolved down to build a PubMLST-type profile.
* One match per locus
* If more than one exact hit is found then the lowest ST is used.


## Building the images locally

7 gene MLST and Core Genome MLST use the same code but different databases
which you build into two separate containers.  This means that you can
update the databases independently.

There are three stages to building the containers:

* Build the database images
* Build the code image
* Build the indexed data images
* Build the final images

These steps are encapsulated in the build-all.sh script.

### Download the data

Clone the [CGPS Typing scripts](https://gitlab.com/cgps/cgps-typing-databases/) repo and follow the README.md

### Index the data

The commands below are run to index the data.

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
DEBUG='cgps:info' npm run index -- --type=cgmlst --index=index_dir --database=cgps-typing-databases
```

NB These commands overwrite the results of one another, you might want to `mv index_dir{,.bak}` between commands

### Building the images

Copy the commands in build-all.sh to build a specific image.

## Testing and developing.

Two Dockerfiles are provided to aid testing and developing the software.

### Working on indexing

To build an image based on an specific cgmlst database download image, and with all necessary dependencies,
run the following command:

```
docker build --rm --build-arg DB_TAG=2023-12-08-cgmlst -t cgmlst:schemedev -f Dockerfile.schemedev . 
```

### General development

To build an image for with indexed databases and all dependencies run (e.g. for testing cgMLST on a specific schema):

```
docker build --rm --build-arg DATA_VERSION=2023-12-08-senterica_1-v5.4.0-0 --build-arg DATA_NAME=cgmlst -t mlst:dev-build -f Dockerfile.dev .
```

## Singularity

While we don't support Singularity directly, it is possible to convert the Docker images to Singularity and run them.

Convert the docker image to singularity format - edit the image name as appropriate:
`docker run -v /var/run/docker.sock:/var/run/docker.sock -v /home/corin/temp:/output --privileged -t --rm quay.io/singularity/docker2singularity registry.gitlab.com/cgps/pathogenwatch-tasks/{mlst/mlst2/cgmlst/ngmast}:{IMAGE_TAG}`

Then prepare the DB folder:
`singularity exec pathogenwatch-mlst-231123-v5.2.0.sif cp -rp /usr/local/mlst/index_dir .`

To run it against a genome replace `{/local/path/to/my.fasta}` with the full path to the FASTA file, along with the TAXID parameter:
`singularity exec --pwd=/usr/local/mlst --bind {/local/path/to/my.fasta}:/tmp/my.fasta --env TAXID=620 pathogenwatch-mlst-202214121127-v3.2.1.sif sh -c 'cat /tmp/my.fasta | /usr/local/bin/node /usr/local/mlst/index.js'.`
