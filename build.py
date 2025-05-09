# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "docker",
#     "typer",
# ]
# ///

import csv
import json
import sys
from pathlib import Path
from typing import Annotated

import docker
import typer
from docker.errors import ImageNotFound, BuildError


def full(
        schemes_file: Annotated[
            Path,
            typer.Argument(
                help="Path to the CSV file with the format "
                     "'<scheme shortname>,<image tag>,<image full name>' (no header)",
                exists=True,
                file_okay=True,
                dir_okay=False,
            ),
        ],
        code_version: Annotated[
            str,
            typer.Option(
                "-v",
                "--code-version",
                help="Version of the MLST code image to use.")] = "v7.0.0",
        mlst_basename: Annotated[
            str,
            typer.Option(
                "-m",
                "--mlst-basename",
                help="Code and schemes images basename"
            )] = "registry.gitlab.com/cgps/cgps-mlst",
) -> None:
    schemes: list[dict[str, str]] = []
    with open(schemes_file, 'r') as scheme_fh:
        reader = csv.reader(scheme_fh, delimiter=",")
        for row in reader:
            schemes.append({
                "name": row[0],
                "date": row[1],
                "image": row[2]
            })
    client = docker.from_env()

    # Confirm the code image exists
    code_image_name = f"{mlst_basename}/mlst-code:{code_version}"
    try:
        code_image = client.images.get(code_image_name)
        if code_image is None:
            raise ImageNotFound
    except ImageNotFound:
        print(f"Unable to find the MLST code image: {code_image_name}")
        exit(1)

    # Confirm all the expected scheme images exist
    for scheme in schemes:
        try:
            scheme_data_image = client.images.get(scheme["image"])
            if scheme_data_image is None:
                raise ImageNotFound
        except ImageNotFound:
            print(f"Unable to find the source image for {scheme['image']}")
            exit(1)

    scheme_descs = {}

    print(f"{len(schemes)} schemes found", file=sys.stderr)

    for scheme in schemes:
        scheme_metadata = json.loads(client.containers.run(scheme["image"], remove=True).decode("utf-8"))['schemes'][0]
        scheme_tag = f"{scheme['date']}-{scheme['name']}"
        new_scheme_tag = scheme_tag if scheme_metadata["type"] != "other" else scheme["date"]
        scheme_type = scheme_metadata['type'].replace("alternative_mlst", "mlst2").replace("other", scheme["name"])
        new_image_name = f"{mlst_basename}/{scheme_type}:{new_scheme_tag}"
        print(f"Building image {new_image_name} for {scheme['name']} version {scheme_tag}", file=sys.stderr)
        # index --scheme=klebsiella_1 --index=index_dir --database=/typing-databases
        try:
            image, log = client.images.build(
                path=".",
                tag=new_image_name,
                rm=True,
                buildargs={
                    "SCHEME": scheme["name"],
                    "SCHEME_TAG": scheme_tag,
                    "CODE_VERSION": code_version
                },

            )
            scheme_metadata["image"] = new_image_name
            scheme_descs[scheme["name"]] = scheme_metadata
        except BuildError as e:
            print(f"Error building image for {scheme['name']}: {e}", file=sys.stderr)
            exit(1)
    print(json.dumps(scheme_descs), file=sys.stdout)


def log_docker_output(generator, task_name: str = 'docker command execution') -> None:
    """
    Log output to console from a generator returned from docker client
    :param Any generator: The generator to log the output of
    :param str task_name: A name to give the task, i.e. 'Build database image', used for logging
    """
    while True:
        try:
            output = generator.__next__()
            if 'stream' in output:
                output_str = output['stream'].strip('\r\n').strip('\n')
                click.echo(output_str)
        except StopIteration:
            click.echo(f'{task_name} complete.')
            break
        except ValueError:
            click.echo(f'Error parsing output from {task_name}: {output}')

if __name__ == "__main__":
    typer.run(full)

