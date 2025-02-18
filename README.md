# CGPS MLST/cgMLST profile assignments
## Running MLST

e.g. to search `my.fasta` against the klebsiella MLST scheme downloaded on 3rd Sept 2024 and save the results in `my_output.json`.
```
cat my.fasta > docker run --rm -i registry.gitlab.com/cgps/cgps-mlst:2024-09-03-klebsiella_1 > my_output.json
```

For a full list of schemes and their tags view the [schemes.json file](https://github.com/pathogenwatch-oss/typing-databases/blob/main/schemes.json).


You can get information for debugging by passing in the `DEBUG` environment variable, e.g:

```
... | docker run --rm -i -e DEBUG='cgps:*,-cgps:trace*' registry...
```

The output data also includes more details if you set the `DEBUG` environment variable.  This includes
the position of the best match and any other close matches.  You can see this without much clutter
by setting `DEBUG='.'`.

## Making a release
### Full release
- If the code has changed create a new code image according to the instructions
- Create the individual scheme images as defined in [CGPS Typing scripts](https://github.com/pathogenwatch-oss/typing-databases) and save the output file.
- Run `python3 build.py -v [code image version] [scheme file CSV] > latest_schemes.json`

### Individual species releases.
The follow the instructions as for a full release but only provide a single line CSV file.

### Input CSV file description
```
scheme shortname,date stamp,scheme image name
```
This is the format output by the typing-databases build script.

1. The shortname is as in the schemes.json file.
2. The date stamp is expected to be ISO format, e.g. `2024-09-03`.
3. The scheme image name.

## How it works

This project loads typing databases which have been collected using the [CGPS Typing scripts](https://github.com/pathogenwatch-oss/typing-databases).  These
scripts download data from a variety of sources and reformat them consistently.  The build is stored as a docker image.
This will take several hours if you are trying to update all of the databases at once.

This project indexes the typing databases so that typing can be run quickly.  This includes hashing all known alleles of each locus.

Genomes are typed by searching for exact matches and by calling Blast.  Exact matches are found by looking for prefixes and in the assembly and
then comparing the hash of a sequence with a list of known hashes.

BLAST is used to identify novel alleles (i.e. ones which are not included in the database).  This is done in a couple of rounds.  The first round Blasts
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

There are three stages to building the containers:

* Build the database images
* Build the code image
* Build the final images

The final image build consists of two stages. The first indexes the schemes while the second creates a compiled image
of the code and indexed scheme.

## Developing locally

Dockerfile.schemedev allows the building of a development environment for running test code inside.

Schemes can be mounted from images for testing locally using the (e.g) the following command:

```
docker run --rm -it --mount type=volume,dst=/db,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/home/corin/cgps-gits/pathogenwatch/mlst/db --entrypoint /bin/sh registry.gitlab.com/cgps/pathogenwatch/analyses/typing-databases:2024-09-03-klebsiella_1
```

Similarly indexed schemes can be mounted from built (or index stage images).


## Index the data

The commands below are run to index the data.

After downloading the data it needs to be indexed before we can
use it to call STs.  This formats the data into a consistent format and
calculates things like hashes of alleles to enable quick exact matches.

Replace `${SCHEME}` with the shortname of the scheme.
```
DEBUG='cgps:info' npm run index -- --scheme=${SCHEME} --index=index_dir --database=/typing-databases
```

## Singularity

While we don't support Singularity directly, it is possible to convert the Docker images to Singularity and run them.

Convert the docker image to singularity format - edit the image name as appropriate:
`docker run -v /var/run/docker.sock:/var/run/docker.sock -v /home/corin/temp:/output --privileged -t --rm quay.io/singularity/docker2singularity registry.gitlab.com/cgps/pathogenwatch-tasks/{mlst/mlst2/cgmlst/ngmast}:{IMAGE_TAG}`

Then prepare the DB folder:
`singularity exec pathogenwatch-mlst-231123-v5.2.0.sif cp -rp /usr/local/mlst/index_dir .`

To run it against a genome replace `{/local/path/to/my.fasta}` with the full path to the FASTA file, along with the TAXID parameter:
`singularity exec --pwd=/usr/local/mlst --bind {/local/path/to/my.fasta}:/tmp/my.fasta pathogenwatch-mlst-202214121127-v3.2.1.sif sh -c 'cat /tmp/my.fasta | /usr/local/bin/node /usr/local/mlst/index.js'.`

### Build singularity image from scratch
Build image:
```bash
singularity build --fakeroot build/mlst.sif mlst.def
```

Usage:
```bash
# Run indexer
singularity exec --pwd /usr/local/mlst build/mlst.sif npm run index -- --scheme=<scheme_name> --index=<index_dir> --database=<typing_databases_dir>

# Run mlst
singularity run --pwd /usr/local/mlst build/mlst.sif <input_fasta_file> <output_json_file> <scheme_name> <index_dir>
```
