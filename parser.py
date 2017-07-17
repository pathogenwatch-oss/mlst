#!/usr/bin/env python

import csv
import json
import os
import re
import sys

from hashlib import sha1

taxid = os.environ.get('taxid', 'Unknown')
scheme = os.environ.get('scheme', 'Unknown')
species = os.environ.get('species', 'Unknown')

# Fasta header rows look like:
# >saureus.glpF~99 CGH5_08.fasta
fasta_header_regex = re.compile("^>[^ ]*\.([^ ]*) .*$")

(st_csv_path, novel_allele_path) = sys.argv[1:]

with open(st_csv_path, "r") as st_csv_file:
    header_row = st_csv_file.readline().strip().split(',') # do nothing with this
    data = st_csv_file.readline().strip().split(',')

sequence_type = data[2]
gene_names = header_row[3:]
alleles = data[3:]

gene_alleles = [gene + allele for (gene, allele) in zip(gene_names, alleles)]
gene_allele_lookup = {el: i for i, el in enumerate(gene_alleles)}

with open(novel_allele_path, "r") as novel_allele_file:
    # Parse the file until we match a fasta header row
    for row in novel_allele_file:
        if fasta_header_regex.match(row.strip()):
            break
    else:
        row = None # We're at the end of the file

    while row:
        fasta_header = row.strip()
        (gene_allele,) = fasta_header_regex.match(fasta_header).groups()
        # Lookup which allele has a novel variant
        allele_index = gene_allele_lookup[gene_allele]

        # Create a SHA1 of the sequence for the novel allele
        allele_hash = sha1()
        for row in novel_allele_file:
            if fasta_header_regex.match(row.strip()):
                break
            allele_hash.update(row.strip().lower())
        else:
            row = None # We're at the end of the file

        # Replace the allele (like ~99) with the hashed sequence
        alleles[allele_index] = allele_hash.hexdigest().lower()

allele_code = "_".join(alleles).lower()
if sequence_type == "-":
    sequence_type = sha1(allele_code).hexdigest().lower()

print(json.dumps({
    "st": sequence_type,
    "code": allele_code,
    "alleles": list(zip(gene_names, alleles)),
    "taxid": taxid,
    "scheme": scheme,
    "species": species,
}))
