## Running MLST

You can manually run seven gene as follows:

```
cat FILE_TO_BE_TYPED.fasta | docker run -i -e WGSA_ORGANISM_TAXID=ORGANISM_TAXID --rm mlst:VERSION
```

For example:

```
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 --rm mlst:v6
```

You can get information for debugging by passing in the `DEBUG` environment variable:

```
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*' --rm mlst:v6
cat tests/data/saureus_duplicate.fasta | docker run -i -e WGSA_ORGANISM_TAXID=1280 -e DEBUG='*,-trace*' --rm mlst:v6
```

The output data also includes more details if you set the `DEBUG` environment variable.  This includes 
the position of the best match and any other close matches.  You can see this without much clutter 
by setting `DEBUG='.'`.

You can run Core Genome MLST by running the `cgmlst` container instead of the `mlst` container.

## Building the containers

7 gene MLST and Core Genome MLST use the same code but different databases 
which you build into two separate containers.  This means that you can 
update the databases independently.  The following commands can be used 
to build the containers.

```
docker build -f Dockerfile.mlst -t mlst:<VERSION> .
docker build -f Dockerfile.cgMlst -t cgmlst:<VERSION> .
```

## Building a database

It take quite a long time to build the containers (around an hour?).  This is 
largely because downloads are throttled to one request per second.  If you're 
in a hurry, look for line like this:

```
    this.downloader = new SlowDownloader(1000);
```

and change `1000` (i.e. 1000 milliseconds) to a smaller value.  Don't abuse 
this though because it might make the owners of the databases sad.

The databases are automatically updated when you build the container.  If 
you want to force a database update without changing any of the code then 
look for a line like:

```
    chmod -R a+r /opt/mlst/databases # Built 19 September 2017
```

and bump the `Built` date.

## Running the tests

Building the databases takes quite a long time so, if you don't need to test 
the database building code, it's better to pull a container with a database 
and test the code there.

To test 7 gene MLST:

```
docker run --rm -it -v $(pwd):/usr/local/mlst -w /usr/local/mlst/tests <EXISTING_DOCKER_CONTAINER> bash test.sh
```

You can use the same command with a Core Genome MLST container.