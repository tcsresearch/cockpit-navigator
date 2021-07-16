/* 
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 Josh Boudreau      <jboudreau@45drives.com>
	Copyright (C) 2021 Sam Silver         <ssilver@45drives.com>
	Copyright (C) 2021 Dawson Della Valle <ddellavalle@45drives.com>

	This file is part of Cockpit Navigator.
	Cockpit Navigator is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	Cockpit Navigator is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.
	You should have received a copy of the GNU General Public License
	along with Cockpit Navigator.  If not, see <https://www.gnu.org/licenses/>.
 */

import {NavWindow} from "./NavWindow.js";
import {format_time_remaining} from "../functions.js";
import {ModalPrompt} from "./ModalPrompt.js";

export class FileUpload {
	/**
	 * 
	 * @param {File|Blob} file 
	 * @param {NavWindow} nav_window_ref
	 * @param {string|undefined} path_prefix 
	 */
	constructor(file, nav_window_ref, path_prefix = "") {
		try {
			this.chunk_size = (parseInt(cockpit.info.version) > 238)? 1048576 : 65536;
		} catch(e) {
			console.log(e);
			this.chunk_size = 65536;
		}
		this.filename = path_prefix + file.name;
		this.nav_window_ref = nav_window_ref;
		this.path = nav_window_ref.pwd().path_str() + "/" + this.filename;
		this.reader = new FileReader();
		this.chunks = this.slice_file(file);
		this.chunk_index = 0;
		this.timestamp = Date.now();
		this.modal_prompt = new ModalPrompt();
		this.using_webkit = true;
	}

	check_if_exists() {
		return new Promise((resolve, reject) => {
			var proc = cockpit.spawn(["/usr/share/cockpit/navigator/scripts/fail-if-exists.py3", this.path], {superuser: "try"});
			proc.done((data) => {resolve(false)});
			proc.fail((e, data) => {resolve(true)});
		});
	}

	make_html_element() {
		var notification = document.createElement("div");
		notification.classList.add("nav-notification");

		var header = document.createElement("div");
		header.classList.add("nav-notification-header");
		notification.appendChild(header);
		header.innerText = "Uploading " + this.filename;
		header.style.position = "relative";
		header.style.paddingRight = "1em";

		var cancel = document.createElement("i");
		cancel.classList.add("fa", "fa-times");
		cancel.style.position = "absolute"
		cancel.style.right = "0";
		cancel.style.cursor = "pointer";
		cancel.onclick = () => {
			if (this.proc) {
				this.reader.onload = () => {};
				this.done();
			}
		}
		header.appendChild(cancel);

		var info = document.createElement("div");
		info.classList.add("flex-row", "space-between");
		notification.appendChild(info);

		var rate = document.createElement("div");
		rate.classList.add("monospace-sm");
		info.appendChild(rate);
		rate.innerText = "-";
		this.rate = rate;

		var eta = document.createElement("div");
		eta.classList.add("monospace-sm");
		info.appendChild(eta);
		eta.innerText = "-";
		this.eta = eta;

		var progress = document.createElement("progress");
		progress.max = this.num_chunks;
		notification.appendChild(progress);
		this.progress = progress;

		this.html_elements = [progress, eta, rate, info, header, notification];
		document.getElementById("nav-notifications").appendChild(notification);
	}

	remove_html_element() {
		for (let elem of this.html_elements) {
			if (elem.parentElement)
				elem.parentElement.removeChild(elem);
		}
	}

	/**
	 * 
	 * @param {File|Blob} file 
	 * @returns {Blob[]}
	 */
	slice_file(file) {
		var offset = 0;
		var next_offset;
		var chunks = [];
		this.num_chunks = Math.ceil(file.size / this.chunk_size);
		for (let i = 0; i < this.num_chunks; i++) {
			next_offset = Math.min(this.chunk_size * (i + 1), file.size);
			chunks.push(file.slice(offset, next_offset));
			offset = next_offset;
		}
		return chunks;
	}

	async upload() {
		this.make_html_element();
		this.proc = cockpit.spawn(["/usr/share/cockpit/navigator/scripts/write-chunks.py3", this.path], {err: "out", superuser: "try"});
		this.proc.fail((e, data) => {
			this.reader.onload = () => {}
			this.done();
			this.nav_window_ref.modal_prompt.alert(e, data);
		})
		this.proc.done((data) => {
			this.nav_window_ref.refresh();
		})
		this.reader.onerror = (evt) => {
			this.modal_prompt.alert("Failed to read file: " + this.filename, "Upload of directories not supported.");
			this.done();
		}
		this.reader.onload = (evt) => {
			this.write_to_file(evt, this.chunk_index * this.chunk_size);
			this.chunk_index++;
			this.progress.value = this.chunk_index;
			if (this.chunk_index < this.num_chunks)
				this.reader.readAsArrayBuffer(this.chunks[this.chunk_index]);
			else {
				this.done();
			}
		};
		try {
			this.reader.readAsArrayBuffer(this.chunks[0]);
		} catch {
			this.reader.onload = () => {};
			if (this.using_webkit) {
				this.proc.input(JSON.stringify({seek: 0, chunk: ""}), true);
			} else {
				this.modal_prompt.alert("Failed to read file: " + this.filename, "Upload of directories and empty files not supported.");
			}
			this.done();
		}
	}

	/**
	 * 
	 * @param {ArrayBuffer} buffer 
	 * @returns 
	 */
	arrayBufferToBase64(buffer) {
		let binary = '';
		let bytes = new Uint8Array(buffer);
		let len = bytes.byteLength;
		for (let i = 0; i < len; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return window.btoa(binary);
	}

	/**
	 * 
	 * @param {Event} evt 
	 */
	write_to_file(evt) {
		var chunk_b64 = this.arrayBufferToBase64(evt.target.result);
		const seek = this.chunk_index * this.chunk_size;
		var obj = {
			seek: seek,
			chunk: chunk_b64
		};
		this.proc.input(JSON.stringify(obj) + "\n", true);
		this.update_xfr_rate();
	}

	done() {
		this.proc.input(); // close stdin
		this.remove_html_element();
	}

	update_xfr_rate() {
		var now = Date.now();
		var elapsed = (now - this.timestamp) / 1000;
		this.timestamp = now;
		var rate = this.chunk_size / elapsed;
		this.rate.innerText = cockpit.format_bytes_per_sec(rate);
		// keep exponential moving average of chunk time for eta
		this.chunk_time = (this.chunk_time)
			? (0.125 * elapsed + (0.875 * this.chunk_time))
			: elapsed;
		var eta = (this.num_chunks - this.chunk_index) * this.chunk_time;
		this.eta.innerText = format_time_remaining(eta);
	}
}