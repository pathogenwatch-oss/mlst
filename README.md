## Running MLST

You can manually run seven gene as follows:

```
cat FILE_TO_BE_TYPED.fasta | docker run -i -e WGSA_ORGANISM_TAXID=ORGANISM_TAXID --rm registry.gitlab.com/cgps/wgsa-tasks/mlst:latest
# or
cat FILE_TO_BE_TYPED.fasta | docker run -i -e WGSA_ORGANISM_TAXID=ORGANISM_TAXID --rm registry.gitlab.com/cgps/wgsa-tasks/cgmlst:latest
```

For example:

```
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 --rm registry.gitlab.com/cgps/wgsa-tasks/mlst:latest
```

You can get information for debugging by passing in the `DEBUG` environment variable:

```
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*,-trace*' --rm registry.gitlab.com/cgps/wgsa-tasks/mlst:latest
```

The output data also includes more details if you set the `DEBUG` environment variable.  This includes 
the position of the best match and any other close matches.  You can see this without much clutter 
by setting `DEBUG='.'`.

You can run Core Genome MLST by running the `cgmlst` container instead of the `mlst` container.

```
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*' --rm registry.gitlab.com/cgps/wgsa-tasks/cgmlst:latest
```

## Building the containers

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
    -e ENTEROBASE_API_KEY="your enterobase api key" \
    -e DEBUG='*,-follow-redirects' \
    node:8 \
        npm install && \
        node schemes/download-databases.js
```

Downloaded files are stored in `data/cache` in a hierarcy similar to 
their URL.  If the download fails, you'll find a load of files which are 
zero bytes (`find data/cache -type f -size 0`).  Delete those files and 
rerun the command to try again.

You can also update just a section of the data by deleting the relevant 
files from the cache and rerunning this command.

### Index the data

The previous step downloaded data, this needs to be indexed before we can 
use it to call STs.  This formats the data into a consistent format and 
calculates things like hashes of alleles to enable quick exact matches.

We build separate containers for 7 gene and core genome MLST as follows.

```
docker build -t registry.gitlab.com/cgps/wgsa-tasks/mlst -f Dockerfile .
docker build -t --build_args TYPE=cgmlst registry.gitlab.com/cgps/wgsa-tasks/cgmlst -f Dockerfile .
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
        bash test.sh
```

You can use the same command with a Core Genome MLST container.  The tests 
should also be run automatically when you build a new container.
